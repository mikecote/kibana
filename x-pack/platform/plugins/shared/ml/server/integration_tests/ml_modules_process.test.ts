/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import { dataViewSavedObjectType } from '@kbn/data-views-plugin/server';
import { captureModuleFiles } from '../models/data_recognizer/module_files';
import { getMlSavedObjectTypes } from '../saved_objects';
import { contribution as mlContribution } from '../task_types/workflow_services_contribution';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { contribution as dataViewsContribution } from '@kbn/workflows-execution-engine/server/task_types/data_views_runtime_contribution';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const resultSchema = z.object({
  id: z.string().optional(),
  jobs: z.array(z.string()).optional(),
  datafeeds: z.array(z.string()).optional(),
  logo: z.boolean().optional(),
  error: z.string().optional(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native portable ML modules in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let deniedKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        savedObjectTypes: [dataViewSavedObjectType, ...getMlSavedObjectTypes()],
        settings: {
          dataViewsRuntime: {
            scriptedFieldsEnabled: false,
            rollupsEnabled: false,
            dataTiersExcludedForFields: true,
            fieldListCachingEnabled: true,
          },
          mlWorkflowRuntime: {
            enabledFeatures: { ad: true, dfa: true, nlp: true },
            compatibleModuleType: null,
            spacesEnabled: true,
            cpsEnabled: false,
            cloud: { isInTrial: false },
            moduleFiles: await captureModuleFiles(),
          },
        },
        seedContributions: { 'workflow-steps': [dataViewsContribution, mlContribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/ml_module_contribution.ts')],
        },
        workflows: { modules: { steps: [{ name: 'module', type: 'test.ml.modules', with: {} }] } },
        seed: async ({ es, host }) => {
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('ML proof requires native Security');
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                ml_denied: {
                  application: 'kibana-.kibana',
                  name: 'ml_denied',
                  actions: [security.authz.actions.login],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'ml-denied',
            role_descriptors: {
              denied: {
                cluster: ['monitor_ml'],
                indices: [],
                applications: [
                  { application: 'kibana-.kibana', privileges: ['ml_denied'], resources: ['*'] },
                ],
              },
            },
          });
          deniedKey = key.encoded;
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });
    it('loads complete built-in jobs, datafeeds and logos from dispatched assets and rechecks task privileges', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      const results: Array<z.infer<typeof resultSchema>> = [];
      for (const apiKey of [harness.apiKey, deniedKey, harness.apiKey]) {
        await harness.run('modules', failure, { apiKey });
        const execution = (await harness.executionsOf('modules')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No new ML execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        results.push(outputSchema.parse(step.output));
      }
      const nativeModule = {
        id: 'logs_ui_analysis',
        jobs: ['log-entry-rate'],
        datafeeds: ['datafeed-log-entry-rate'],
        logo: true,
      };
      expect(results[0]).toEqual(nativeModule);
      expect(results[1]).toEqual({ error: expect.stringContaining('Insufficient') });
      expect(results[2]).toEqual(nativeModule);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
