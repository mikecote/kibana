/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import { ALL_VALUE, Duration, DurationUnit } from '@kbn/slo-schema';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { contribution } from '../workflow_services_contribution';
import { DefaultBurnRatesClient } from '../../services/burn_rates_client';
import { DefaultSLODefinitionRepository } from '../../services/slo_definition_repository';
import { createSLO } from '../../services/fixtures/slo';
import { slo, sloSettings } from '../../saved_objects';
import { SLI_DESTINATION_INDEX_PATTERN } from '../../../common/constants';

const resultSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  error: z.string().optional(),
  sliValue: z.number().nullable().optional(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native SLO providers in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let restrictedKey: string;
    let nativeDeniedMessage: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: { sloRuntime: { enabled: true, spacesEnabled: true } },
        savedObjectTypes: [slo, sloSettings],
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/slo_data_provider_contribution.ts')],
        },
        seedContributions: { 'workflow-steps': [contribution] },
        workflows: {
          read: { steps: [{ name: 'slo', type: 'test.slo.details', with: {} }] },
          rename: {
            steps: [
              { name: 'slo', type: 'test.slo.details', with: { rename: 'Updated native SLO' } },
            ],
          },
        },
        seed: async ({ es, host }) => {
          const definition = createSLO({ id: 'worker-slo', name: 'Original native SLO' });
          await new DefaultSLODefinitionRepository(
            host.savedObjects.getUnsafeInternalClient(),
            host.logger
          ).create(definition);
          const sliIndex = SLI_DESTINATION_INDEX_PATTERN.replace('*', '-workflow-proof');
          await es.indices.create({
            index: sliIndex,
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                slo: {
                  properties: {
                    id: { type: 'keyword' },
                    revision: { type: 'long' },
                    numerator: { type: 'long' },
                    denominator: { type: 'long' },
                  },
                },
              },
            },
          });
          await es.index({
            index: sliIndex,
            refresh: 'wait_for',
            document: {
              '@timestamp': new Date(Date.now() - 60000).toISOString(),
              slo: { id: 'worker-slo', revision: 1, numerator: 9999, denominator: 10000 },
            },
          });
          await es.indices.refresh({ index: '.kibana*' });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('The native SLO proof requires Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                slo_worker_read: {
                  application: 'kibana-.kibana',
                  name: 'slo_worker_read',
                  actions: [actions.login, actions.savedObject.get('*', '*')],
                },
              },
            },
          });
          ({ encoded: restrictedKey } = await es.security.createApiKey({
            name: 'slo-without-summary-access',
            role_descriptors: {
              limited: {
                cluster: [],
                indices: [
                  { names: ['.kibana*'], privileges: ['all'], allow_restricted_indices: true },
                ],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['slo_worker_read'],
                    resources: ['*'],
                  },
                ],
              },
            },
          }));
          const restricted = host.elasticsearch.asScoped({
            headers: { authorization: `ApiKey ${restrictedKey}` },
          }).asCurrentUser;
          await expect(restricted.search({ index: sliIndex })).rejects.toHaveProperty(
            'meta.statusCode',
            403
          );
          let nativeError: Error | undefined;
          try {
            await new DefaultBurnRatesClient(restricted).calculate(definition, ALL_VALUE, [
              { name: '5m', duration: new Duration(5, DurationUnit.Minute) },
            ]);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            nativeError = error;
          }
          if (!nativeError)
            throw new Error('Native SLO burn rates unexpectedly allowed the restricted key');
          nativeDeniedMessage = nativeError.message;
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });

    it('reads current SLO definitions and enforces current-user ES permissions across retained runs', async () => {
      const failure = jest.fn();
      const seen = new Set<string>();
      for (const operation of ['read', 'rename', 'read', 'denied', 'read']) {
        const workflow = operation === 'rename' ? 'rename' : 'read';
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
        const steps = await harness.stepsOf(execution.id);
        const output = outputSchema.parse(steps.find(({ stepId }) => stepId === 'slo')?.output);
        if (operation === 'denied') {
          expect(output.error).toBe(nativeDeniedMessage);
          expect(output.id).toBeUndefined();
        } else {
          expect(output).toEqual({
            id: 'worker-slo',
            sliValue: 0.9999,
            name: seen.size === 1 ? 'Original native SLO' : 'Updated native SLO',
          });
        }
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 5);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
