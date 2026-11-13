/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { TaskAlreadyRunningError } from '@kbn/task-manager-plugin/server/lib/errors/task_already_running_error';
import { TaskPriority, TaskStatus } from '@kbn/task-manager-plugin/server/task';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host }) => {
    const nativeHost = host as Pick<TaskHost, 'taskManager' | 'elasticsearch' | 'server'>;
    const { taskManager } = nativeHost;
    if (!taskManager) throw new Error('The scheduling proof requires native Task Manager');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.task_scheduling.native_pool',
        label: 'Native dispatch pool',
        description: 'Exercise native force checks against the live dispatch pool',
        category: StepCategory.Kibana,
        inputSchema: z.object({ taskId: z.string().min(1).max(1024) }),
        outputSchema: z.object({
          blockedFirst: z.boolean(),
          forced: z.boolean(),
          blockedThird: z.boolean(),
          apiKeyId: z.string(),
        }),
        handler: async (context) => {
          const { taskId } = context.input;
          await taskManager.schedule(
            {
              id: taskId,
              taskType: 'workflow:resume',
              params: { workflowRunId: taskId, spaceId: 'default' },
              state: {},
              scope: ['test:active-pool'],
              runAt: new Date(Date.now() + 86400000),
            },
            { request: context.contextManager.getFakeRequest(), cloneApiKey: true }
          );
          const claim = () =>
            nativeHost.elasticsearch.asInternalUser.update({
              index: '.kibana_task_manager',
              id: `task:${taskId}`,
              doc: {
                task: {
                  status: TaskStatus.Running,
                  ownerId: `kibana:${nativeHost.server.uuid}`,
                  startedAt: new Date().toISOString(),
                },
              },
            });
          const assertBlocked = async (): Promise<void> => {
            try {
              await taskManager.runSoon(taskId, true);
            } catch (error) {
              if (error instanceof TaskAlreadyRunningError) return;
              throw error;
            }
            throw new Error('A task in the live dispatch pool was forced');
          };
          await claim();
          await assertBlocked();
          if ((await taskManager.get(taskId)).status !== TaskStatus.Running)
            throw new Error('The refused force call changed the running task');
          const forced = await taskManager.runSoon(taskId, {
            force: true,
            priority: TaskPriority.UserInteractive,
            requestImmediateClaim: true,
          });
          const idle = await taskManager.get(taskId);
          if (idle.status !== TaskStatus.Idle || idle.priority !== TaskPriority.UserInteractive)
            throw new Error('Native force did not persist its status and priority');
          await claim();
          await assertBlocked();
          if (!idle.userScope?.apiKeyId || !idle.apiKey)
            throw new Error('Native task credentials were not read back');
          if (!Buffer.from(idle.apiKey, 'base64').toString().includes(idle.userScope.apiKeyId))
            throw new Error('Native task credential decryption failed');
          return {
            output: {
              blockedFirst: true,
              forced: forced.forced,
              blockedThird: true,
              apiKeyId: idle.userScope.apiKeyId,
            },
          };
        },
      })
    );
  },
};
