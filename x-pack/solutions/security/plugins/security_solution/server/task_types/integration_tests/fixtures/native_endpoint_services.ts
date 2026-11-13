/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import { ES_SEARCH_STRATEGY } from '@kbn/data-plugin/common';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import type { EndpointWorkflowServices } from '../../endpoint_workflow_services';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services }) => {
    if (!services) throw new Error('Native Endpoint proof requires execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.security.native_endpoint',
        label: 'Native Endpoint services',
        description: 'Read Endpoint authorization, policy gates and scoped search in a worker',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          found: z.number(),
          graphEnabled: z.boolean(),
          optedIn: z.boolean(),
          fleetRead: z.boolean(),
          spaceId: z.string(),
        }),
        handler: async (context) => {
          const { endpointAppContextService: endpoint } = await services
            .getService<EndpointWorkflowServices>('securitySolution.endpoint')
            .getServices();
          const request = context.contextManager.getFakeRequest();
          const authorization = await endpoint.getEndpointAuthz(request);
          const client = await endpoint.getScopedSearchClient(request);
          const result = await firstValueFrom(
            client.search(
              { params: { index: 'native-endpoint-docs', body: { query: { match_all: {} } } } },
              { strategy: ES_SEARCH_STRATEGY }
            )
          );
          return {
            output: {
              found: result.rawResponse.hits.hits.length,
              graphEnabled: endpoint
                .getProductFeaturesService()
                .isEnabled(ProductFeatureKey.graphVisualization),
              optedIn: endpoint.getTelemetryConfigProvider().getIsOptedIn() === true,
              fleetRead: authorization.canReadFleetAgents,
              spaceId: endpoint.getActiveSpaceId(request),
            },
          };
        },
      })
    );
  },
};
