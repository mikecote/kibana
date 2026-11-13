/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z, lazySchema } from '@kbn/zod/v4';
import { createObservabilityTaskDataRegistry } from '@kbn/observability-agent-builder-plugin/server/task_types/create_data_registry';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';

const errorSchema = lazySchema(() =>
  z.object({
    error: z.object({ error: z.object({ exception: z.array(z.object({ message: z.string() })) }) }),
  })
);
export const contribution: WorkflowStepsContribution = {
  register: (registry, { services, host }) => {
    if (!services) throw new Error('Native data-provider proof requires workflow services');
    const dataRegistry = createObservabilityTaskDataRegistry({
      snapshot: {
        dataProviders: [
          { id: 'apmErrorDetails', owner: 'apm' },
          { id: 'infraHosts', owner: 'infra' },
        ],
      },
      getService: services.getService,
      logger: (host as TaskHost).logger,
    });
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.observability.native_providers',
        label: 'Native Observability providers',
        description:
          'Read actual APM errors and Infrastructure host metrics through their owning native factories',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          message: z.string(),
          hosts: z.array(z.string()),
          cpu: z.number().nullable(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const start = new Date(Date.now() - 3600000).toISOString();
          const end = new Date(Date.now() + 60000).toISOString();
          const error = errorSchema.parse(
            await dataRegistry.getData('apmErrorDetails', {
              request,
              errorId: 'native-apm-error',
              serviceName: 'checkout',
              serviceEnvironment: '',
              start,
              end,
            })
          );
          const result = await dataRegistry.getData('infraHosts', {
            request,
            from: start,
            to: end,
            limit: 10,
            query: undefined,
          });
          if (!result) throw new Error('The native Infra provider was not resolved');
          const cpu = result.nodes
            .find(({ name }) => name === 'native-host')
            ?.metrics.find(({ name }) => name === 'cpuV2')?.value;
          if (cpu === undefined)
            throw new Error('The native Infrastructure provider returned no host CPU metric');
          return {
            output: {
              message: error.error.error.exception[0].message,
              hosts: result.nodes.map(({ name }) => name).sort(),
              cpu,
            },
          };
        },
      })
    );
  },
};
