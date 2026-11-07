/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { taskType as scheduledTaskType } from '@kbn/workflows-execution-engine/server/task_types/workflow_scheduled.task';
import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import { defineTaskType } from '@kbn/task-manager-plugin/server/task_type_module';

const defineMiddlewareProof = (module: TaskTypeModule): TaskTypeModule => {
  const { contributions } = module;
  const apply = contributions?.apply;
  if (!contributions || !apply)
    throw new Error('Middleware proof requires the native workflow contributions');
  return defineTaskType({
    ...module,
    contributions: {
      keys: contributions.keys,
      apply: (contributed) => defineMiddlewareProof(apply(contributed)),
    },
    type: 'test:native-middleware',
    title: 'Native middleware proof',
    createTaskRunner: (context, host) => ({
      run: async () => {
        const { taskManager } = host;
        const { fakeRequest } = context;
        const { taskId } = context.taskInstance.params;
        if (!taskManager || !fakeRequest || typeof taskId !== 'string') {
          throw new Error('Native middleware proof requires Task Manager, a request and a task id');
        }
        await taskManager.schedule(
          {
            id: taskId,
            taskType: 'workflow:run',
            params: { workflowRunId: taskId, spaceId: 'default', trackExecutionTimeline: true },
            state: {},
            scope: ['test:middleware'],
            runAt: new Date(Date.now() + 86400000),
          },
          { request: fakeRequest, cloneApiKey: true }
        );
        const task = await taskManager.get(taskId);
        if (!task.apiKey) throw new Error('Native scheduled task credential was not restored');
        const [apiKeyId] = Buffer.from(task.apiKey, 'base64').toString().split(':');
        return { state: { params: task.params, taskState: task.state, apiKeyId } };
      },
    }),
  });
};

export const taskType = defineMiddlewareProof(scheduledTaskType);
