/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defineTaskType } from '@kbn/task-manager-plugin/server/task_runtime';
import { AlertActionsCleanupTaskDefinition as definition } from '../lib/tasks/alert_actions_cleanup/task_definition';
import { AlertActionsCleanupTaskRunner } from '../lib/tasks/alert_actions_cleanup/task_runner';
import { alertingV2ConfigModule, alertingV2EsModule } from '../task_runtime/modules';

/** Deletes dispatcher docs older than the configured retention from `.alert-actions`. */
export const taskType = defineTaskType({
  type: definition.taskType,
  definition: {
    type: definition.taskType,
    title: definition.title,
    description: definition.description,
    timeout: definition.timeout,
    maxAttempts: definition.maxAttempts,
    cost: definition.cost,
    priority: definition.priority,
    paramsSchema: definition.paramsSchema,
  },
  requiresFakeRequest: definition.requiresFakeRequest,
  modules: [alertingV2ConfigModule, alertingV2EsModule],
  needs: { runner: AlertActionsCleanupTaskRunner },
  createRunner: (
    { runner },
    { taskInstance, signal, executionUuid, setCustomTaskRunEventFields }
  ) => ({
    run: () => runner.run({ taskInstance, signal, executionUuid, setCustomTaskRunEventFields }),
  }),
});
