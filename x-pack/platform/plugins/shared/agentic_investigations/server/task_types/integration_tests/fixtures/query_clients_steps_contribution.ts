/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import { getAgenticInvestigationsTaskProcessServices } from '../../create_agentic_investigations_task_process_services';

export const contribution: WorkflowStepsContribution = {
  register: (registry, context) => {
    const { services } = context;
    if (!services) throw new Error('Investigation query proof requires native workflow services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.investigations.queryClients',
        label: 'Native investigation query clients',
        description: 'Reads investigation and subject data using the native scoped clients.',
        category: StepCategory.Ai,
        inputSchema: z.object({ conversationId: z.string(), subjectId: z.string() }),
        outputSchema: z.object({
          id: z.string(),
          listedIds: z.array(z.string()),
          openIds: z.array(z.string()),
          subjectIds: z.array(z.string()),
        }),
        handler: async (step) => {
          const runtime = getAgenticInvestigationsTaskProcessServices({
            ...context,
            services: {
              getService: services.getService,
              getAgentBuilderStart: () =>
                services.getService<AgentBuilderPluginStart>('agentBuilder'),
              getWorkflowsManagement: () => services.getService('workflows.management'),
            },
          });
          const request = step.contextManager.getFakeRequest();
          const client = runtime.getInvestigationsClient(request);
          const investigation = await client.get(step.input.conversationId);
          const listed = await client.list();
          const open = await client.findOpenBySubjects([
            { type: 'manual', id: step.input.subjectId },
          ]);
          const subjects = await runtime
            .getSubjectsClient(request)
            .listByConversationIds([step.input.conversationId]);
          return {
            output: {
              id: investigation.id,
              listedIds: listed.results.map(({ id }) => id),
              openIds: open.map(({ id }) => id),
              subjectIds: subjects.map(({ id }) => id),
            },
          };
        },
      })
    );
  },
};
