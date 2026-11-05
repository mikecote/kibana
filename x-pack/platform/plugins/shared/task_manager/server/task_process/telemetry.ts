/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { defer, of } from 'rxjs';
import type { TaskHost } from '../task_type_module';
import type { TaskProcessTelemetry } from './wire';

interface RunStore {
  telemetry: TaskProcessTelemetry;
  featureFlags: Record<string, boolean | string | number>;
}

const storage = new AsyncLocalStorage<RunStore>();

const emptyTelemetry = (): TaskProcessTelemetry => ({ events: [], featureUsages: [], custom: [] });

/**
 * Runs `fn`, collecting what it reports. A process may serve several runs at once, so each run has
 * its own buffer, found through the async context the run executes in.
 */
export const collectTelemetry = async <T>(
  fn: () => Promise<T>,
  { featureFlags = {} }: { featureFlags?: RunStore['featureFlags'] } = {}
): Promise<{ value?: T; error?: unknown; telemetry: TaskProcessTelemetry }> => {
  const store: RunStore = { telemetry: emptyTelemetry(), featureFlags };
  try {
    return { value: await storage.run(store, fn), telemetry: store.telemetry };
  } catch (error) {
    return { error, telemetry: store.telemetry };
  }
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
 * What a task type module reports through, in a task process: nothing is sent from here. It is kept
 * for the run that reported it and returned with the result, so Kibana reports it with its own
 * analytics, licensing and plugin channels. Reports outside a run are dropped.
 */
export const createHostTelemetry = (): Pick<TaskHost, 'analytics' | 'telemetry'> & {
  featureUsage: NonNullable<NonNullable<TaskHost['licensing']>['featureUsage']>;
} => ({
  analytics: {
    reportEvent: (eventType: string, data: unknown) => {
      storage.getStore()?.telemetry.events.push({ eventType, data });
    },
  } as TaskHost['analytics'],
  telemetry: {
    report: (kind, payload) => {
      storage.getStore()?.telemetry.custom.push({ kind, payload });
    },
  },
  featureUsage: {
    notifyUsage: (featureName, usedAt) => {
      storage.getStore()?.telemetry.featureUsages.push({
        featureName,
        ...(usedAt ? { lastUsed: new Date(usedAt).toISOString() } : {}),
      });
    },
  },
});
