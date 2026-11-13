/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID } from '@kbn/alerting-plugin/server/task_types/rule_data_views_settings';
import { ALERTING_RUN_SETTINGS_ID } from '@kbn/alerting-plugin/server/task_types/rule_run_settings';
import { dataViewSavedObjectType } from '@kbn/data-views-plugin/server';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import { z } from '@kbn/zod/v4';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';
import { contribution as dataViewsContribution } from '../task_types/data_views_runtime_contribution';

const features: KibanaFeatureConfig[] = ['indexPatterns', 'advancedSettings'].map((id) => ({
  id,
  name: id,
  category: { id: 'management', label: 'Management' },
  app: [id],
  privileges: {
    all: { savedObject: { all: ['index-pattern', 'config'], read: [] }, ui: ['save'] },
    read: { savedObject: { all: [], read: ['index-pattern', 'config'] }, ui: [] },
  },
}));
const resultSchema = z.object({
  canSave: z.boolean(),
  scripted: z.boolean(),
  fields: z.array(z.string()),
  error: z.string().optional(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native data views in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let readOnlyKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        savedObjectTypes: [dataViewSavedObjectType],
        settings: {
          [ALERTING_RUN_SETTINGS_ID]: {
            maintenanceWindowsEnabled: true,
            dataViews: { scriptedFieldsEnabled: false },
          },
          [RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID]: { features, spacesEnabled: true },
          dataViewsRuntime: {
            scriptedFieldsEnabled: false,
            rollupsEnabled: false,
            dataTiersExcludedForFields: true,
            fieldListCachingEnabled: true,
          },
          spacesRuntime: {
            config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
            buildFlavor: 'traditional',
            features,
            cpsEnabled: false,
          },
        },
        seedContributions: { 'workflow-steps': [dataViewsContribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/data_views_contribution.ts')],
        },
        workflows: {
          'rule-write': {
            steps: [
              {
                name: 'dataViews',
                type: 'test.data_views.native',
                with: { write: true, runtime: 'rule' },
              },
            ],
          },
          'rule-read': {
            steps: [
              {
                name: 'dataViews',
                type: 'test.data_views.native',
                with: { write: false, runtime: 'rule' },
              },
            ],
          },
          write: {
            steps: [{ name: 'dataViews', type: 'test.data_views.native', with: { write: true } }],
          },
          read: {
            steps: [{ name: 'dataViews', type: 'test.data_views.native', with: { write: false } }],
          },
        },
        seed: async ({ es, host }) => {
          await es.indices.create({
            index: 'workflow-data-view-001',
            mappings: {
              properties: { '@timestamp': { type: 'date' }, duration: { type: 'long' } },
            },
          });
          await es.index({
            index: 'workflow-data-view-001',
            refresh: 'wait_for',
            document: { '@timestamp': new Date().toISOString(), duration: 42 },
          });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Data views proof requires native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                data_view_reader: {
                  application: 'kibana-.kibana',
                  name: 'data_view_reader',
                  actions: [
                    actions.login,
                    actions.savedObject.get('index-pattern', 'get'),
                    actions.savedObject.get('index-pattern', 'bulk_get'),
                    actions.savedObject.get('index-pattern', 'find'),
                    actions.savedObject.get('config', 'get'),
                  ],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'data-view-reader',
            role_descriptors: {
              reader: {
                cluster: [],
                indices: [
                  { names: ['workflow-data-view-*'], privileges: ['read', 'view_index_metadata'] },
                ],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['data_view_reader'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          readOnlyKey = key.encoded;
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });
    it('uses real fields and saved objects while rechecking each task identity and active space', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      for (const runtime of ['workflow', 'rule'] as const) {
        const results: Array<z.infer<typeof resultSchema>> = [];
        for (const [workflow, limited] of [
          ['write', false],
          ['read', true],
          ['write', true],
          ['write', false],
          ['write', false],
          ['write', false],
        ] as const) {
          if (results.length === 4 || results.length === 5) {
            await harness.es.update({
              index: '.kibana',
              id: 'space:default',
              refresh: 'wait_for',
              doc: { space: { disabledFeatures: results.length === 4 ? ['indexPatterns'] : [] } },
            });
          }
          const workflowId = runtime === 'rule' ? `rule-${workflow}` : workflow;
          await harness.run(workflowId, failure, {
            apiKey: limited ? readOnlyKey : harness.apiKey,
          });
          const execution = (await harness.executionsOf(workflowId)).find(
            ({ id }) => !seen.has(id)
          );
          if (!execution) throw new Error('No new data view execution was persisted');
          seen.add(execution.id);
          expect({ status: execution.status, error: execution.error }).toEqual({
            status: 'completed',
            error: undefined,
          });
          const [step] = await harness.stepsOf(execution.id);
          results.push(outputSchema.parse(step.output));
        }
        expect(results.map(({ canSave, scripted }) => ({ canSave, scripted }))).toEqual([
          { canSave: true, scripted: false },
          { canSave: false, scripted: false },
          { canSave: false, scripted: false },
          { canSave: true, scripted: false },
          { canSave: false, scripted: false },
          { canSave: true, scripted: false },
        ]);
        for (const result of results)
          expect(result.fields).toEqual(expect.arrayContaining(['@timestamp', 'duration']));
        expect(results[2].error).toBe('Operation failed due to insufficient access, id: undefined');
        expect(results[4].error).toBe(results[2].error);
        expect(results[0].error).toBeUndefined();
        expect(results[3].error).toBeUndefined();
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 12);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
