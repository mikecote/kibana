/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { contribution } from '../task_types/workflow_services_contribution';
import { getSyntheticsMonitorConfigSavedObjectType } from '../saved_objects/synthetics_monitor/synthetics_monitor_config';
import { monitorConfigMappings } from '../saved_objects/synthetics_monitor/monitor_mappings';
import {
  createMonitorAttributes,
  MODERN_MONITOR_ID,
  LEGACY_MONITOR_ID,
} from './fixtures/monitor_attributes';

const resultSchema = z.object({
  monitor: z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      enabled: z.boolean(),
      schedule: z.object({ number: z.string(), unit: z.string() }),
      locations: z.array(z.object({ id: z.string(), label: z.string() })),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  error: z.string().optional(),
  forbidden: z.boolean().optional(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);
const operations = ['read', 'legacy', 'rename', 'read', 'denied', 'legacy', 'read'] as const;

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native monitor providers in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let restrictedKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          synthetics: { service: { manifestUrl: 'https://manifest.test' }, isCpsEnabled: false },
        },
        savedObjectTypes: [
          getSyntheticsMonitorConfigSavedObjectType(),
          { name: 'synthetics-monitor', mappings: monitorConfigMappings },
        ],
        seedContributions: { 'workflow-steps': [contribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/monitor_data_provider_contribution.ts')],
        },
        workflows: {
          read: { steps: [{ name: 'monitor', type: 'test.synthetics.monitor', with: {} }] },
          legacy: {
            steps: [{ name: 'monitor', type: 'test.synthetics.monitor', with: { legacy: true } }],
          },
          rename: {
            steps: [{ name: 'monitor', type: 'test.synthetics.monitor', with: { rename: true } }],
          },
        },
        seed: async ({ es, host }) => {
          const client = host.savedObjects.getUnsafeInternalClient();
          for (const [type, id] of [
            ['synthetics-monitor-multi-space', MODERN_MONITOR_ID],
            ['synthetics-monitor', LEGACY_MONITOR_ID],
          ] as const) {
            await client.create(type, createMonitorAttributes('Original native monitor'), { id });
            if (!host.encryptedSavedObjects)
              throw new Error('Monitor proof requires native encryption');
            const decrypted = await host.encryptedSavedObjects
              .getClient()
              .getDecryptedAsInternalUser<{ secrets: string }>(type, id);
            expect(decrypted.attributes.secrets).toContain('worker-monitor-secret');
          }
          await es.indices.refresh({ index: '.kibana*' });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('The monitor proof requires Security');
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                monitor_login_only: {
                  application: 'kibana-.kibana',
                  name: 'monitor_login_only',
                  actions: [security.authz.actions.login],
                },
              },
            },
          });
          ({ encoded: restrictedKey } = await es.security.createApiKey({
            name: 'monitor-without-saved-object-access',
            role_descriptors: {
              limited: {
                cluster: [],
                indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['monitor_login_only'],
                    resources: ['*'],
                  },
                ],
              },
            },
          }));
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });

    it('reads modern and legacy monitors without exposing secrets and retains neither data nor permissions', async () => {
      const failure = jest.fn();
      const seen = new Set<string>();
      let renamed = false;
      for (const operation of operations) {
        const workflow = operation === 'denied' ? 'read' : operation;
        await harness.run(
          workflow,
          failure,
          operation === 'denied' ? { apiKey: restrictedKey } : undefined
        );
        const executions = (await harness.executionsOf(workflow)).filter(({ id }) => !seen.has(id));
        expect(executions).toHaveLength(1);
        const [execution] = executions;
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const step = (await harness.stepsOf(execution.id)).find(
          ({ stepId }) => stepId === 'monitor'
        );
        const output = outputSchema.parse(step?.output);
        if (operation === 'rename') renamed = true;
        if (operation === 'denied') {
          expect(output).toEqual({
            error: 'Unable to bulk_get synthetics-monitor,synthetics-monitor-multi-space',
            forbidden: true,
          });
          expect(output.monitor).toBeUndefined();
        } else {
          expect(output).toEqual({
            monitor: {
              id: operation === 'legacy' ? LEGACY_MONITOR_ID : MODERN_MONITOR_ID,
              name:
                renamed && operation !== 'legacy'
                  ? 'Updated native monitor'
                  : 'Original native monitor',
              type: 'http',
              enabled: true,
              schedule: { number: '3', unit: 'm' },
              locations: [{ id: 'us-east', label: 'US East' }],
              tags: ['production'],
            },
          });
        }
        expect(JSON.stringify(step?.output)).not.toContain('worker-monitor-secret');
        expect(JSON.stringify(step?.output)).not.toContain('secrets');
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : operations.length);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
