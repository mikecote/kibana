/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { TaskHost } from '../task_type_module';
import type { TaskProcessTelemetry } from './wire';

const storage = new AsyncLocalStorage<TaskProcessTelemetry>();

const emptyTelemetry = (): TaskProcessTelemetry => ({ events: [], featureUsages: [], custom: [] });

/**
 * Runs `fn`, collecting what it reports. A process may serve several runs at once, so each run has
 * its own buffer, found through the async context the run executes in.
 */
export const collectTelemetry = async <T>(
  fn: () => Promise<T>
): Promise<{ value?: T; error?: unknown; telemetry: TaskProcessTelemetry }> => {
  const telemetry = emptyTelemetry();
  try {
    return { value: await storage.run(telemetry, fn), telemetry };
  } catch (error) {
    return { error, telemetry };
  }
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
      storage.getStore()?.events.push({ eventType, data });
    },
  } as TaskHost['analytics'],
  telemetry: {
    report: (kind, payload) => {
      storage.getStore()?.custom.push({ kind, payload });
    },
  },
  featureUsage: {
    notifyUsage: (featureName, usedAt) => {
      storage.getStore()?.featureUsages.push({
        featureName,
        ...(usedAt ? { lastUsed: new Date(usedAt).toISOString() } : {}),
      });
    },
  },
});
