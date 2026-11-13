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
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { DefaultSLODefinitionRepository } from '../../../services/slo_definition_repository';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host: taskHost, services }) => {
    if (!services) throw new Error('SLO fixture requires execution services');
    const host = taskHost as TaskHost;
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.slo.details',
        label: 'Native SLO details',
        description: 'Read the native SLO provider under the current execution identity',
        category: StepCategory.Kibana,
        inputSchema: z.object({ rename: z.string().optional() }),
        outputSchema: z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          error: z.string().optional(),
          sliValue: z.number().nullable().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          if (context.input.rename) {
            const repository = new DefaultSLODefinitionRepository(
              host.savedObjects.getScopedClient(request),
              host.logger
            );
            const definition = await repository.findById('worker-slo');
            await repository.update({ ...definition, name: context.input.rename });
          }
          const provider = services.getService<
            Pick<ObservabilityAgentBuilderDataRegistryTypes, 'sloDetails'>
          >('observabilityAgentBuilder.dataProviders.slo');
          try {
            const result = await provider.sloDetails({ request, sloId: 'worker-slo' });
            return {
              output: { id: result.id, name: result.name, sliValue: result.summary.sliValue },
            };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { output: { error: error.message } };
          }
        },
      })
    );
  },
};
