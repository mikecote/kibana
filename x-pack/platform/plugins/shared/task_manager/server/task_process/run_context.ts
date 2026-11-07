/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { defer, of } from 'rxjs';
import type { TaskHost } from '../task_type_module';

interface RunStore {
  featureFlags: Record<string, boolean | string | number>;
  flushers: Array<() => Promise<void>>;
}

const storage = new AsyncLocalStorage<RunStore>();

/**
 * Runs `fn` with what is particular to one run. A process may serve several runs at once, so each
 * run's values are found through the async context the run executes in.
 */
export const runInRunContext = async <T>(
  fn: () => Promise<T>,
  { featureFlags = {}, flushers = [] }: Partial<RunStore> = {}
): Promise<{ value?: T; error?: unknown }> => {
  try {
    return { value: await storage.run({ featureFlags, flushers }, fn) };
  } catch (error) {
    return { error };
  }
};

/** Registers a flusher for the active execution and reports whether a run is active. */
export const registerRunFlusher = (flusher: () => Promise<void>): boolean => {
  const run = storage.getStore();
  if (!run) return false;
  run.flushers.push(flusher);
  return true;
};

/**
 * The feature flags of a task process: what Kibana evaluated for the run that is asking, and the
 * fallback of the caller for a flag the task type did not declare, as Core answers without a provider.
 */
export const createHostFeatureFlags = (): NonNullable<TaskHost['featureFlags']> => {
  const read = <T extends boolean | string | number>(flagName: string, fallbackValue: T): T => {
    const value = storage.getStore()?.featureFlags[flagName];
    return (typeof value === typeof fallbackValue ? value : fallbackValue) as T;
  };
  return {
    getBooleanValue$: (flagName, fallbackValue) => defer(() => of(read(flagName, fallbackValue))),
    getStringValue$: (flagName, fallbackValue) => defer(() => of(read(flagName, fallbackValue))),
    getNumberValue$: (flagName, fallbackValue) => defer(() => of(read(flagName, fallbackValue))),
  } as NonNullable<TaskHost['featureFlags']>;
};

/**
 * How long a process waits for what a run left to do (shipping its events) before it answers.
 * Kibana waits a few seconds past the deadline of a run, which this must stay inside.
 */
export const FLUSH_TIMEOUT_MS = 4000;

/**
 * Runs what plugins asked the process to finish before it answers a run. A slow or failing endpoint
 * must not hold or fail the run, so it is bounded and only logged.
 */
export const runFlushers = async (
  flushers: Array<() => Promise<void>>,
  logger: { warn: (message: string) => void },
  timeoutMs: number = FLUSH_TIMEOUT_MS
): Promise<boolean> => {
  if (!flushers.length) return true;
  let successful = true;
  const pending = new Map(
    flushers.map((flusher, index) => [index, flusher.name || `flusher ${index}`])
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const flushed = Promise.all(
    flushers.map((flusher, index) =>
      Promise.resolve()
        .then(flusher)
        .catch((error) => {
          successful = false;
          logger.warn(`Flush failed: ${(error as Error).message}`);
        })
        .finally(() => pending.delete(index))
    )
  );
  try {
    if ((await Promise.race([flushed, timedOut])) === 'timeout') {
      logger.warn(
        `Flushing did not finish in ${timeoutMs}ms; pending: ${[...pending.values()].join(
          ', '
        )}; the run answers without waiting`
      );
      return false;
    }
    return successful;
  } finally {
    clearTimeout(timer);
  }
};
