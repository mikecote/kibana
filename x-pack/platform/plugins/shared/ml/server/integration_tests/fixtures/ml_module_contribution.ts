/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { SharedServices } from '../../shared_services/shared_services';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, services }) => {
    if (!services) throw new Error('ML module proof requires native workflow services');
    const nativeHost = host as TaskHost;
    const ml = services.getService<SharedServices>('ml.setup');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.ml.modules',
        label: 'Native ML module',
        description:
          'Read portable native ML module assets through licensed and authorized shared services',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          id: z.string().optional(),
          jobs: z.array(z.string()).optional(),
          datafeeds: z.array(z.string()).optional(),
          logo: z.boolean().optional(),
          error: z.string().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          try {
            const module = await ml
              .modulesProvider(request, nativeHost.savedObjects.getScopedClient(request))
              .getModule('logs_ui_analysis');
            return {
              output: {
                id: module.id,
                jobs: module.jobs.map(({ id }) => id),
                datafeeds: module.datafeeds.map(({ id }) => id),
                logo: Boolean(module.logo),
              },
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
