/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID } from '@kbn/alerting-plugin/server/task_types/rule_data_views_settings';
import type { AlertingRunSettings } from '@kbn/alerting-plugin/server/task_types/rule_run_settings';
import { ALERTING_RUN_SETTINGS_ID } from '@kbn/alerting-plugin/server/task_types/rule_run_settings';
import { createRuleDataViews } from '@kbn/alerting-plugin/server/task_types/standalone/create_rule_data_views';
import { createStandaloneFieldFormats } from '@kbn/alerting-plugin/server/task_types/standalone/field_formats';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [ALERTING_RUN_SETTINGS_ID, RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID] },
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
        inputSchema: z.object({
          write: z.boolean(),
          runtime: z.enum(['workflow', 'rule']).default('workflow'),
        }),
        outputSchema: z.object({
          canSave: z.boolean(),
          scripted: z.boolean(),
          fields: z.array(z.string()),
          error: z.string().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const runSettings = nativeHost.settings?.[ALERTING_RUN_SETTINGS_ID] as
            | AlertingRunSettings
            | undefined;
          if (context.input.runtime === 'rule' && !runSettings)
            throw new Error('Native rule data views proof requires dispatch settings');
          const scopedDataViews =
            context.input.runtime === 'rule' && runSettings
              ? createRuleDataViews(nativeHost, runSettings, createStandaloneFieldFormats())
              : dataViews;
          const client = await scopedDataViews.dataViewsServiceFactory(
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
