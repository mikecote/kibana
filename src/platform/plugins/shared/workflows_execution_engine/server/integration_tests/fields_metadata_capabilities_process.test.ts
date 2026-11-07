/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

const features: KibanaFeatureConfig[] = ['fleet', 'fleetv2'].map((id) => ({
  id,
  name: id,
  category: { id: 'management', label: 'Management' },
  app: [id],
  privileges: {
    all: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
    read: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
  },
}));

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Field metadata authorization in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let limitedKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        additionalContributions: {
          'workflow-steps': [
            join(__dirname, 'fixtures/fields_metadata_capabilities_contribution.ts'),
          ],
        },
        settings: {
          fieldsMetadataRuntime: {},
          spacesRuntime: {
            config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
            buildFlavor: 'traditional',
            features,
            cpsEnabled: false,
          },
        },
        workflows: {
          capabilities: {
            steps: [{ name: 'capabilities', type: 'test.fields_metadata.capabilities', with: {} }],
          },
        },
        seed: async ({ es, host }) => {
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('The capability fixture requires native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                metadata_reader: {
                  application: 'kibana-.kibana',
                  name: 'metadata_reader',
                  actions: [actions.login, actions.ui.get('fleet', 'read')],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'metadata-reader',
            role_descriptors: {
              reader: {
                cluster: [],
                indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['metadata_reader'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          limitedKey = key.encoded;
        },
      });
    }, 240000);
    afterAll(async () => {
      await harness?.stop();
    });

    it('rechecks real API key privileges and space settings without retaining earlier grants', async () => {
      const onDispatchFailure = jest.fn();
      const results: Array<{
        fleet: boolean;
        fleetv2: boolean;
        disabledFeatures: string[];
        ecsSource: string;
        fipsEnabled: boolean;
      }> = [];
      const seen = new Set<string>();
      const run = async (apiKey: string) => {
        await harness.run('capabilities', onDispatchFailure, { apiKey });
        const executions = await harness.executionsOf('capabilities');
        const execution = executions.find(({ id }) => !seen.has(id));
        expect(execution).toBeDefined();
        if (!execution) throw new Error('No new capability execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        results.push(step.output.output ?? step.output);
      };
      await run(harness.apiKey);
      await run(limitedKey);
      await run(harness.apiKey);
      await harness.es.update({
        index: '.kibana',
        id: 'space:default',
        refresh: 'wait_for',
        doc: { space: { disabledFeatures: ['fleet'] } },
      });
      await run(harness.apiKey);
      expect(results).toEqual([
        { fleet: true, fleetv2: true, disabledFeatures: [], ecsSource: 'ecs', fipsEnabled: false },
        { fleet: true, fleetv2: false, disabledFeatures: [], ecsSource: 'ecs', fipsEnabled: false },
        { fleet: true, fleetv2: true, disabledFeatures: [], ecsSource: 'ecs', fipsEnabled: false },
        {
          fleet: false,
          fleetv2: true,
          disabledFeatures: ['fleet'],
          ecsSource: 'ecs',
          fipsEnabled: false,
        },
      ]);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 4);
      expect(harness.kibanaRequests).toEqual([]);
      expect(onDispatchFailure).not.toHaveBeenCalled();
    }, 180000);
  }
);
