/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { schema } from '@kbn/config-schema';
import {
  WORKFLOW_RESUME_TASK_TYPE,
  WORKFLOW_RUN_TASK_TYPE,
  WORKFLOW_SCHEDULED_TASK_TYPE,
} from './types';

/**
 * Max Task Manager attempts for `workflow:run`.
 * - Attempt 1: normal `runWorkflow` execution.
 * - Attempts > 1: `resolveInterruptedWorkflowRunTask` runs first; when it marks the execution FAILED
 *   (interrupt recovery) the runner returns without re-executing user logic - so attempt 2 is not a
 *   second full workflow run in that case.
 * - A third attempt mainly covers transient failures persisting that recovery (e.g. ES unavailable)
 *   or a thrown error on attempt 1 where attempt 2 still runs recovery then `runWorkflow` again;
 *   it is not meant as extra user workflow retries after successful interrupt recovery.
 */
export const WORKFLOW_RUN_TASK_MAX_ATTEMPTS = 3;

/**
 * Max Task Manager attempts for `workflow:resume`.
 * Same numeric budget as run but semantics differ: each attempt can run `resumeWorkflow` user logic
 * until interrupt recovery short-circuits or the last attempt applies `resolveExhaustedWorkflowRunTask`
 * after a handler failure - so extra attempts also cover resume work that runs and may throw.
 */
export const WORKFLOW_RESUME_TASK_MAX_ATTEMPTS = 3;

export const WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS = 3;

export const WORKFLOW_TASK_SCHEDULING_DEFINITIONS = {
  [WORKFLOW_RUN_TASK_TYPE]: {
    type: WORKFLOW_RUN_TASK_TYPE,
    title: 'Run Workflow',
    description: 'Executes a workflow immediately',
    timeout: '365d',
    maxAttempts: WORKFLOW_RUN_TASK_MAX_ATTEMPTS,
  },
  [WORKFLOW_RESUME_TASK_TYPE]: {
    type: WORKFLOW_RESUME_TASK_TYPE,
    paramsSchema: schema.object({ workflowRunId: schema.string(), spaceId: schema.string() }),
    title: 'Resume Workflow',
    description: 'Resumes a paused workflow',
    allowPriorityOverride: true,
    timeout: '365d',
    maxAttempts: WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
  },
  [WORKFLOW_SCHEDULED_TASK_TYPE]: {
    type: WORKFLOW_SCHEDULED_TASK_TYPE,
    title: 'Scheduled Workflow Execution',
    description: 'Executes workflows on a scheduled basis',
    timeout: '365d',
    maxAttempts: WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS,
  },
};
