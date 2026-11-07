/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { NativeTaskSchedulingSchemas } from '@kbn/task-manager-plugin/server/task_scheduling_snapshot';
import type { TaskSchedulingContribution } from '@kbn/task-manager-plugin/server/task_scheduling_contribution';
import { RULE_EXECUTOR_TASK_METADATA } from '../lib/rule_executor/task_metadata';
import { ALERTING_V2_TASK_PROCESS_SETTINGS_ID } from './task_process_settings';

export const contribution = {
  createSchemas: (settings): Readonly<Record<string, NativeTaskSchedulingSchemas>> => {
    if (!settings[ALERTING_V2_TASK_PROCESS_SETTINGS_ID]) return {};
    return {
      [RULE_EXECUTOR_TASK_METADATA.taskType]: {
        paramsSchema: RULE_EXECUTOR_TASK_METADATA.paramsSchema,
      },
    };
  },
} satisfies TaskSchedulingContribution;
