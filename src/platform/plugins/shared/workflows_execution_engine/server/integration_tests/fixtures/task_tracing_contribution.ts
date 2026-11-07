/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { context as otelContext, trace } from '@opentelemetry/api';
import apm from 'elastic-apm-node';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { lazySchema, z } from '@kbn/zod/v4';

const labelsSchema = lazySchema(() =>
  z.object({ name: z.string().optional(), id: z.string().optional() })
);

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host }) => {
    const { taskManager, executionContext } = host as Pick<
      TaskHost,
      'taskManager' | 'executionContext'
    >;
    if (!taskManager) throw new Error('Trace proof requires native Task Manager');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.task_tracing.native',
        label: 'Native task trace',
        description: 'Read the actual task transaction and persist its scheduling trace parent',
        category: StepCategory.Kibana,
        inputSchema: z.object({ taskId: z.string().min(1).max(1024) }),
        outputSchema: z.object({
          apmTraceparent: z.string().nullable(),
          otelTraceId: z.string().nullable(),
          scheduledTraceparent: z.string(),
          executionLabels: labelsSchema,
        }),
        handler: async (context) => {
          const transaction = apm.currentTransaction;
          const span = trace.getSpan(otelContext.active());
          await taskManager.schedule(
            {
              id: context.input.taskId,
              taskType: 'workflow:run',
              params: { workflowRunId: context.input.taskId, spaceId: 'default' },
              state: {},
              scope: ['test:trace'],
              runAt: new Date(Date.now() + 86400000),
            },
            { request: context.contextManager.getFakeRequest(), cloneApiKey: true }
          );
          const task = await taskManager.get(context.input.taskId);
          return {
            output: {
              apmTraceparent: transaction?.traceparent ?? null,
              otelTraceId: span?.spanContext().traceId ?? null,
              scheduledTraceparent: task.traceparent ?? '',
              executionLabels: labelsSchema.parse(executionContext.getAsLabels()),
            },
          };
        },
      })
    );
  },
};
