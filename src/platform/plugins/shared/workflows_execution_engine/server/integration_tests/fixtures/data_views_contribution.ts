/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, services }) => {
    if (!services) throw new Error('Data view proof requires native workflow services');
    const nativeHost = host as TaskHost;
    const dataViews = services.getService<DataViewsServerPluginStart>('dataViews');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.data_views.native',
        label: 'Native data views',
        description: 'Create and read data views with native field discovery and authorization',
        category: StepCategory.Kibana,
        inputSchema: z.object({ write: z.boolean() }),
        outputSchema: z.object({
          canSave: z.boolean(),
          scripted: z.boolean(),
          fields: z.array(z.string()),
          error: z.string().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const client = await dataViews.dataViewsServiceFactory(
            nativeHost.savedObjects.getScopedClient(request),
            nativeHost.elasticsearch.asScoped(request).asCurrentUser,
            request
          );
          try {
            const canSave = await client.getCanSave();
            let error: string | undefined;
            if (context.input.write) {
              try {
                await client.createAndSave(
                  {
                    id: 'native-data-view',
                    title: 'workflow-data-view-*',
                    timeFieldName: '@timestamp',
                  },
                  true
                );
              } catch (cause) {
                if (!(cause instanceof Error)) throw cause;
                if (canSave)
                  throw new Error(`Native data view creation failed: ${cause.message}`, { cause });
                error = cause.message;
              }
            }
            const view = await client.get('native-data-view');
            return {
              output: {
                canSave,
                scripted: dataViews.getScriptedFieldsEnabled(),
                fields: view.fields
                  .getAll()
                  .map(({ name }) => name)
                  .sort(),
                ...(error ? { error } : {}),
              },
            };
          } finally {
            client.clearInstanceCache();
          }
        },
      })
    );
  },
};
