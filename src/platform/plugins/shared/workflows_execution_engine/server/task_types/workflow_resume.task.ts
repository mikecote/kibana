/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { schema } from '@kbn/config-schema';
import { defineWorkflowTaskType } from './define_workflow_task_type';
import { WORKFLOW_RESUME_TASK_MAX_ATTEMPTS } from '../create_workflow_runtime';
import { WORKFLOW_RESUME_TASK_TYPE } from '../workflow_task_manager/types';

export const taskType = defineWorkflowTaskType(
  {
    type: WORKFLOW_RESUME_TASK_TYPE,
    paramsSchema: schema.object({
      workflowRunId: schema.string(),
      spaceId: schema.string(),
    }),
    title: 'Resume Workflow',
    description: 'Resumes a paused workflow',
    allowPriorityOverride: true,
    // Set high timeout for long-running workflows.
    // The workflow timeout logic defined in workflow execution engine logic is the primary control.
    timeout: '365d',
    // Retries allow `resolveInterruptedWorkflowResumeTask` to fail-fast abandoned executions after interrupt.
    maxAttempts: WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
  },
  (runtime) => runtime.resumeWorkflowTask
);
