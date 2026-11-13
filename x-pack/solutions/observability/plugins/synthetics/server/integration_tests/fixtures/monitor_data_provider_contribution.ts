/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { SavedObjectsErrorHelpers } from '@kbn/core-saved-objects-server';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import {
  createMonitorAttributes,
  MODERN_MONITOR_ID,
  LEGACY_MONITOR_ID,
} from './monitor_attributes';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host: taskHost, services }) => {
    if (!services) throw new Error('The monitor proof requires workflow services');
    const host = taskHost as TaskHost;
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.synthetics.monitor',
        label: 'Native monitor details',
        description: 'Exercise the native monitor provider and encryption registration',
        category: StepCategory.Kibana,
        inputSchema: z.object({ legacy: z.boolean().optional(), rename: z.boolean().optional() }),
        outputSchema: z.object({
          monitor: z
            .object({
              id: z.string(),
              name: z.string(),
              type: z.string(),
              enabled: z.boolean(),
              schedule: z.object({ number: z.string(), unit: z.string() }),
              locations: z.array(z.object({ id: z.string(), label: z.string() })),
              tags: z.array(z.string()).optional(),
            })
            .optional(),
          error: z.string().optional(),
          forbidden: z.boolean().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const type = context.input.legacy
            ? 'synthetics-monitor'
            : 'synthetics-monitor-multi-space';
          const id = context.input.legacy ? LEGACY_MONITOR_ID : MODERN_MONITOR_ID;
          if (context.input.rename) {
            await host.savedObjects
              .getScopedClient(request)
              .create(type, createMonitorAttributes('Updated native monitor'), {
                id,
                overwrite: true,
              });
          }
          const provider = services.getService<
            Pick<ObservabilityAgentBuilderDataRegistryTypes, 'syntheticsMonitorDetails'>
          >('observabilityAgentBuilder.dataProviders.synthetics');
          try {
            const monitor = await provider.syntheticsMonitorDetails({ request, configId: id });
            return { output: { monitor } };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return {
              output: {
                error: error.message,
                forbidden: SavedObjectsErrorHelpers.isForbiddenError(error),
              },
            };
          }
        },
      })
    );
  },
};
