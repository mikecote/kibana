/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ScopeMetrics } from '@kbn/metrics';
import { AsyncLocalStorage } from 'async_hooks';
import { defer, of } from 'rxjs';
import type { TaskProcessMetrics } from './run_metrics';
import type { TaskExecutionPool } from '../task_scheduling';
import { AdHocTaskCounter } from '../lib/adhoc_task_counter';
import type { TaskHost } from '../task_type_module';

interface RunStore {
  withCoordinatorCapability?: TaskHost['withCoordinatorCapability'];
  featureFlags: Record<string, boolean | string | number>;
  executionId?: string;
  getCurrentTasksInPool?: TaskExecutionPool['getCurrentTasksInPool'];
  adHocTaskCounter: AdHocTaskCounter;
  prometheusMetrics?: TaskProcessMetrics;
  flushers: Array<() => Promise<void>>;
}

const storage = new AsyncLocalStorage<RunStore>();
const activeExecutions = new Set<string>();

export const withTaskCoordinatorCapability: NonNullable<TaskHost['withCoordinatorCapability']> = (
  token,
  use
) => {
  const call = storage.getStore()?.withCoordinatorCapability;
  if (!call) return Promise.reject(new Error('No coordinator capability in the active task run'));
  return call(token, use);
};

/** Lists the execution identities actually served by this worker process. */
export const getActiveTaskExecutions = (): string[] => [...activeExecutions];

/** Requests the dispatching node's current execution pool without substituting worker-local state. */
export const requestDispatchTaskPool = async (): Promise<readonly string[]> => {
  const getPool = storage.getStore()?.getCurrentTasksInPool;
  if (!getPool) throw new Error('The active execution has no dispatch-pool control channel');
  return getPool();
};

/** Counts created tasks in the actual active run's native counter. */
export const incrementCreatedTaskCount = (by: number = 1): void => {
  const run = storage.getStore();
  if (!run) throw new Error('Task creation metrics require an active task execution');
  run.adHocTaskCounter.increment(by);
};

/** Adds forwarded native metric deltas to the active execution's control channel. */
export const accumulateTaskProcessMetrics = (scopes: ScopeMetrics[]): void => {
  const metrics = storage.getStore()?.prometheusMetrics;
  if (!metrics) throw new Error('Native metrics require an active task execution');
  metrics.addDelta(scopes);
};

/**
 * Runs `fn` with what is particular to one run. A process may serve several runs at once, so each
 * run's values are found through the async context the run executes in.
 */
export const runInRunContext = async <T>(
  fn: () => Promise<T>,
  {
    featureFlags = {},
    flushers = [],
    executionId,
    getCurrentTasksInPool,
    withCoordinatorCapability,
    adHocTaskCounter = new AdHocTaskCounter(),
    prometheusMetrics,
  }: Partial<RunStore> = {}
): Promise<{ value?: T; error?: unknown }> => {
  if (executionId) activeExecutions.add(executionId);
  try {
    return {
      value: await storage.run(
        {
          featureFlags,
          flushers,
          executionId,
          getCurrentTasksInPool,
          withCoordinatorCapability,
          adHocTaskCounter,
          prometheusMetrics,
        },
        fn
      ),
    };
  } catch (error) {
    return { error };
  } finally {
    if (executionId) activeExecutions.delete(executionId);
  }
};

/** Registers a flusher for the active execution and reports whether a run is active. */
export const registerRunFlusher = (flusher: () => Promise<void>): boolean => {
  const run = storage.getStore();
  if (!run?.executionId) return false;
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
  };
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
