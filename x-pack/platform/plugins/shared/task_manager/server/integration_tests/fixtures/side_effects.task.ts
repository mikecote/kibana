/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaPackageJson } from '@kbn/repo-info';
import { defineTaskType } from '../../task_type_module';
import type { TaskTypeModule } from '../../task_type_module';

// The telemetry plugin depends on Task Manager, so Task Manager's project cannot reference it: the
// plugin the process runs is loaded by path, which is also how the bundle gets it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTelemetryTaskPlugin } = require('@kbn/telemetry-plugin/server/task_plugin') as {
  createTelemetryTaskPlugin: (
    kibanaVersion: string
  ) => NonNullable<TaskTypeModule['taskPlugins']>[number];
};

export const SIDE_EFFECTS_TASK_TYPE = 'test:side_effects';
export const SIDE_EFFECT_EVENT_TYPE = 'task_process_side_effect_test';
export const USAGE_COUNTER_DOMAIN = 'taskProcessTest';
export const USAGE_COUNTER_NAME = 'side_effect_run';
export const FEATURE_NAME = 'Side effect test feature';

/**
 * A task type that does every side effect a run can have: it reports an analytics event, counts
 * usage and uses a licensed feature. The process must do all of them itself before it answers.
 */
export const taskType = defineTaskType({
  type: SIDE_EFFECTS_TASK_TYPE,
  title: 'Side effects test',
  licensing: true,
  usageCounters: true,
  analyticsEventTypes: [
    {
      eventType: SIDE_EFFECT_EVENT_TYPE,
      schema: {
        value: { type: 'long', _meta: { description: 'A value the test asserts on' } },
      },
    },
  ],
  taskPlugins: [createTelemetryTaskPlugin(kibanaPackageJson.version)],
  createTaskRunner: (_context, host) => ({
    run: async () => {
      host.analytics.reportEvent(SIDE_EFFECT_EVENT_TYPE, { value: 42 });
      host.usageCounters!.getUsageCounter(USAGE_COUNTER_DOMAIN).incrementCounter({
        counterName: USAGE_COUNTER_NAME,
        incrementBy: 3,
      });
      host.licensing!.featureUsage!.notifyUsage(FEATURE_NAME, new Date('2026-01-02T03:04:05.000Z'));
      return { state: { done: true } };
    },
  }),
});
