/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createDashboardServerClient } from '@kbn/dashboard-plugin/server/create_dashboard_server_client';
import type { EmbeddableStart } from '@kbn/embeddable-plugin/server';
import { LENS_EMBEDDABLE_TYPE } from '@kbn/lens-common';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { createDashboardAppStateValidator } from '../../../tools/generate/validate_dashboard_app_state';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, services }) => {
    const taskHost = host as TaskHost;
    if (!services) throw new Error('Native dashboard SDKs require workflow services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sdk.native_dashboard',
        label: 'Read native dashboard',
        description:
          'Read persisted dashboard panels and validate Lens configuration through native SDKs',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          dashboard: z.string(),
          lensIssues: z.number(),
          customMigration: z.string(),
        }),
        handler: async (context) => {
          const embeddable = services.getService<EmbeddableStart>('embeddable');
          const client = createDashboardServerClient({ embeddable, logger: taskHost.logger });
          const dashboard = await client.read(
            taskHost.savedObjects.getScopedClient(context.contextManager.getFakeRequest()),
            'native-dashboard'
          );
          const validator = createDashboardAppStateValidator(embeddable);
          const issues = validator.validatePanel({
            id: 'lens',
            grid: { x: 0, y: 0, w: 12, h: 8 },
            type: LENS_EMBEDDABLE_TYPE,
            config: { ref_id: 12 },
          });
          const migrateCustom = embeddable.getAllMigrations()['8.1.0'];
          if (!migrateCustom) throw new Error('The native custom Lens migration is missing');
          const customMigration = migrateCustom({
            type: 'lens',
            attributes: {
              title: 'Native custom visualization',
              references: [],
              visualizationType: 'rotatingNumber',
              state: {
                query: { language: 'kuery', query: '' },
                filters: [],
                datasourceStates: { indexpattern: { layers: {} } },
                visualization: { column: 'native-column', layerId: 'native-layer' },
              },
            },
          });
          return {
            output: {
              dashboard: JSON.stringify(dashboard),
              lensIssues: issues.length,
              customMigration: JSON.stringify(customMigration),
            },
          };
        },
      })
    );
  },
};
