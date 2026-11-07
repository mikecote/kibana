/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import Boom from '@hapi/boom';
import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import { ALERT_WORKFLOW_STATUS, SLO_BURN_RATE_RULE_TYPE_ID } from '@kbn/rule-data-utils';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services }) => {
    if (!services) throw new Error('The authorized alerts proof requires workflow services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.slo.authorized_alerts',
        label: 'Native authorized alerts',
        description: 'Read and update alerts through the genuine native alert client',
        category: StepCategory.Kibana,
        inputSchema: z.object({ close: z.boolean().optional() }),
        outputSchema: z.object({
          aliases: z.array(z.string()).optional(),
          ids: z.array(z.string()).optional(),
          statuses: z.array(z.string()).optional(),
          error: z.string().optional(),
          forbidden: z.boolean().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const ruleRegistry = services.getService<WorkflowRuleRegistryServices>('ruleRegistry');
          try {
            const client = await ruleRegistry.getRacClientWithRequest(request);
            const aliases = await client.getAuthorizedAlertsIndices([SLO_BURN_RATE_RULE_TYPE_ID]);
            if (context.input.close) {
              await client.bulkUpdate({
                index: (aliases ?? []).join(','),
                ids: ['native-slo-alert'],
                status: 'closed',
              });
            }
            const result = await client.find({
              ruleTypeIds: [SLO_BURN_RATE_RULE_TYPE_ID],
              size: 20,
              track_total_hits: true,
              query: { match_all: {} },
            });
            const ids = result.hits.hits.map((hit) => {
              if (!hit._id) throw new Error('The native alert lookup returned no document ID');
              return hit._id;
            });
            const statuses = result.hits.hits.map((hit) => {
              const status = hit._source?.[ALERT_WORKFLOW_STATUS];
              if (typeof status !== 'string') throw new Error('The alert has no workflow status');
              return status;
            });
            return { output: { aliases, ids, statuses } };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return {
              output: {
                error: error.message,
                forbidden: Boom.isBoom(error) && error.output.statusCode === 403,
              },
            };
          }
        },
      })
    );
  },
};
