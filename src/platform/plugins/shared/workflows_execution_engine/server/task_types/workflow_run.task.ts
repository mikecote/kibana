/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { defineWorkflowTaskType } from './define_workflow_task_type';
import { WORKFLOW_TASK_SCHEDULING_DEFINITIONS } from '../workflow_task_manager/task_scheduling_definitions';
import { WORKFLOW_RUN_TASK_TYPE } from '../workflow_task_manager/types';

export const taskType = defineWorkflowTaskType(
  WORKFLOW_TASK_SCHEDULING_DEFINITIONS[WORKFLOW_RUN_TASK_TYPE],
  (runtime) => runtime.runWorkflowTask
);
