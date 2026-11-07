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
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { NightshiftSourcesServerSetup, NightshiftSourcesServerStart } from '../../../types';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services, host }) => {
    if (!services) throw new Error('Source fixture requires execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.source.update',
        label: 'Update a source',
        description: 'Exercise the source catalog service',
        category: StepCategory.Kibana,
        inputSchema: z.object({ enabled: z.boolean() }),
        outputSchema: z.object({ enabled: z.boolean() }),
        handler: async (context) => {
          const sources = services.getService<
            NightshiftSourcesServerSetup & NightshiftSourcesServerStart
          >('nightshiftSources');
          const unsubscribe = sources.onSourceChange(async (event) => {
            await (host as TaskHost).elasticsearch.asInternalUser.index(
              {
                index: 'test-source-events',
                refresh: 'wait_for',
                document: {
                  type: event.type,
                  enabled: event.source.enabled,
                  spaceId: event.request.spaceId,
                },
              },
              { signal: context.abortSignal }
            );
          });
          try {
            const client = await sources.getSourcesClient({
              request: context.contextManager.getFakeRequest(),
            });
            const source = await client.setEnabled('source-1', context.input.enabled);
            return { output: { enabled: source.enabled } };
          } finally {
            unsubscribe();
          }
        },
      })
    );
  },
};
