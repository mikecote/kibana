/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import {
  contribution as dashboards,
  DASHBOARDS_AGENT_BUILDER_SETTINGS_ID,
} from '../agent_builder_contribution';
import { coreMock } from '@kbn/core/server/mocks';
import { MARKDOWN_EMBEDDABLE_TYPE } from '@kbn/dashboard-markdown/common/constants';
import { createEmbeddableServices } from '@kbn/embeddable-plugin/server/create_embeddable_services';
import { createDashboardSavedObjectType } from '@kbn/dashboard-plugin/server/dashboard_saved_object';
import { EMBEDDABLE_RUNTIME_SETTINGS_ID } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { contribution } from './__fixtures__/native_dashboard_client';
import {
  nativeEmbeddableContributions,
  getNativeContributions,
} from './__fixtures__/native_embeddable_registrations';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native dashboard in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    const flags = { 'lens.apiFormat': false };
    beforeAll(async () => {
      const main = createEmbeddableServices();
      for (const entry of nativeEmbeddableContributions)
        entry.register(main.setup, {
          featureFlags: coreMock.createStart().featureFlags,
          getContributions: getNativeContributions,
          settings: { lensRuntime: { visualizationMigrations: { rotatingNumber: ['8.1.0'] } } },
        });
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        featureFlags: flags,
        savedObjectTypes: [
          createDashboardSavedObjectType({ migrationDeps: { embeddable: main.setup } }),
        ],
        settings: {
          lensRuntime: { visualizationMigrations: { rotatingNumber: ['8.1.0'] } },
          [EMBEDDABLE_RUNTIME_SETTINGS_ID]: main.getRegistrationIds(),
          [DASHBOARDS_AGENT_BUILDER_SETTINGS_ID]: {},
        },
        seedContributions: {
          'workflow-steps': [contribution],
          'agent-builder': [dashboards],
          embeddables: [...nativeEmbeddableContributions],
          'lens-visualization-migrations': [
            ...getNativeContributions('lens-visualization-migrations'),
          ],
        },
        additionalContributions: {
          'workflow-steps': [join(__dirname, '__fixtures__/native_dashboard_client.ts')],
        },
        workflows: {
          dashboard: {
            steps: [{ name: 'read_dashboard', type: 'test.sdk.native_dashboard', with: {} }],
          },
        },
        seed: async ({ host }) => {
          await host.savedObjects.createInternalRepository(['dashboard']).create(
            'dashboard',
            {
              title: 'Native SDK dashboard',
              kibanaSavedObjectMeta: { searchSourceJSON: '{}' },
              panelsJSON: JSON.stringify([
                {
                  type: MARKDOWN_EMBEDDABLE_TYPE,
                  panelIndex: 'markdown',
                  gridData: { i: 'markdown', x: 0, y: 0, w: 12, h: 8 },
                  embeddableConfig: { content: 'Native markdown content' },
                },
              ]),
            },
            { id: 'native-dashboard' }
          );
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('preserves native panels and follows current Lens schemas across retained jobs', async () => {
      const seen = new Set<string>();
      for (const enabled of [false, true, false]) {
        flags['lens.apiFormat'] = enabled;
        await harness.run('dashboard');
        const executions = await harness.executionsOf('dashboard');
        const execution = executions.find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('The native dashboard workflow did not execute');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        expect(step.error).toBeUndefined();
        expect(execution.status).toBe('completed');
        const output = step.output.output ?? step.output;
        expect(output.lensIssues > 0).toBe(enabled);
        const migrated = JSON.parse(output.customMigration);
        expect(migrated.attributes.state.visualization).toEqual({
          accessor: 'native-column',
          layerId: 'native-layer',
          color: '#000000',
        });
        const dashboard = JSON.parse(output.dashboard);
        expect(dashboard.data.title).toBe('Native SDK dashboard');
        expect(dashboard.data.panels).toEqual([
          expect.objectContaining({
            type: MARKDOWN_EMBEDDABLE_TYPE,
            config: expect.objectContaining({ content: 'Native markdown content' }),
          }),
        ]);
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
