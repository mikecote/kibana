/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { AGENTS_INDEX, GLOBAL_SETTINGS_SAVED_OBJECT_TYPE } from '../constants';
import { GLOBAL_SETTINGS_ID } from '../../common/constants';
import type { FleetPackageMetadataTaskProcessSettings } from '../package_metadata_task_process_settings';
import { getSavedObjectTypes } from '../saved_objects';
import { contribution } from '../task_types/workflow_services_contribution';

const metadata: FleetPackageMetadataTaskProcessSettings = {
  config: {
    enabled: true,
    agents: { enabled: true, elasticsearch: {} },
    experimentalFeatures: { useSpaceAwareness: true },
  },
  assets: { bundledPackages: [] },
  elasticConnectorsServerlessEnabled: false,
  kibanaBranch: 'main',
  isProductionMode: false,
  isFipsEnabled: false,
};
const resultSchema = z.object({
  agentIds: z.array(z.string()),
  policyNamespaceType: z.string(),
  preconfigurationNamespaceType: z.string(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Fleet agents in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: { fleetPackageMetadata: metadata },
        savedObjectTypes: Object.values(getSavedObjectTypes({ useSpaceAwareness: true })),
        seedContributions: { 'workflow-steps': [contribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/agents_contribution.ts')],
        },
        workflows: { agents: { steps: [{ name: 'agents', type: 'test.fleet.agents', with: {} }] } },
        seed: async ({ es, host }) => {
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: [GLOBAL_SETTINGS_SAVED_OBJECT_TYPE] })
            .create(
              GLOBAL_SETTINGS_SAVED_OBJECT_TYPE,
              { use_space_awareness_migration_status: 'success' },
              { id: GLOBAL_SETTINGS_ID }
            );
          await es.indices.create({
            index: AGENTS_INDEX,
            mappings: {
              properties: {
                active: { type: 'boolean' },
                namespaces: { type: 'keyword' },
                enrolled_at: { type: 'date' },
                last_checkin: { type: 'date' },
                last_checkin_status: { type: 'keyword' },
                policy_id: { type: 'keyword' },
                policy_revision_idx: { type: 'integer' },
                upgrade_started_at: { type: 'date' },
                upgraded_at: { type: 'date' },
                unenrollment_started_at: { type: 'date' },
                local_metadata: { type: 'flattened' },
              },
            },
          });
          for (const [id, namespace] of [
            ['default-agent', 'default'],
            ['foreign-agent', 'other-space'],
          ]) {
            await es.index({
              index: AGENTS_INDEX,
              id,
              refresh: 'wait_for',
              document: {
                active: true,
                namespaces: [namespace],
                enrolled_at: new Date().toISOString(),
                last_checkin: new Date().toISOString(),
                last_checkin_status: 'online',
                policy_id: 'native-policy',
                agent: { version: '9.6.0', id },
                local_metadata: { host: { hostname: 'shared-host', name: 'shared-host' } },
              },
            });
          }
        },
      });
    }, 300000);
    afterAll(async () => harness?.stop());

    it('uses captured native namespace definitions and reads current agents only in the workflow space', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      for (const active of [true, false, true]) {
        await harness.es.update({
          index: AGENTS_INDEX,
          id: 'default-agent',
          refresh: 'wait_for',
          doc: { active },
        });
        await harness.run('agents', failure);
        const execution = (await harness.executionsOf('agents')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No Fleet agent execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        expect(outputSchema.parse(step.output)).toEqual({
          agentIds: active ? ['default-agent'] : [],
          policyNamespaceType: 'multiple',
          preconfigurationNamespaceType: 'single',
        });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
