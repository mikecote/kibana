/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { TaskSchedulingContribution } from '@kbn/task-manager-plugin/server/task_scheduling_contribution';
import type { NativeTaskSchedulingSchemas } from '@kbn/task-manager-plugin/server/task_scheduling_snapshot';
import { WORKFLOWS_ENGINE_SETTINGS_ID } from './constants';
import { WORKFLOW_TASK_SCHEDULING_DEFINITIONS } from '../workflow_task_manager/task_scheduling_definitions';
import { WORKFLOW_RESUME_TASK_TYPE } from '../workflow_task_manager/types';

export const contribution: TaskSchedulingContribution = {
  createSchemas: (settings): Readonly<Record<string, NativeTaskSchedulingSchemas>> => {
    if (!settings[WORKFLOWS_ENGINE_SETTINGS_ID]) return {};
    return {
      [WORKFLOW_RESUME_TASK_TYPE]: {
        paramsSchema: WORKFLOW_TASK_SCHEDULING_DEFINITIONS[WORKFLOW_RESUME_TASK_TYPE].paramsSchema,
      },
    };
  },
};
