/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ActionsClient } from '@kbn/actions-plugin/server';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services }) => {
    if (!services) throw new Error('The event-log fixture requires execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.actions.execution_logs',
        label: 'Read connector execution logs',
        description: 'Read prior execution effects through the authorized Actions client',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({ total: z.number() }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const client = (await services.getActionsClientWithRequest(request)) as ActionsClient;
          const result = await client.getGlobalExecutionLogWithAuth({
            dateStart: '1d',
            dateEnd: new Date().toISOString(),
            page: 1,
            perPage: 50,
            sort: [{ timestamp: { order: 'desc' } }],
            namespaces: ['default'],
          });
          return { output: { total: result.total } };
        },
      })
    );
  },
};
