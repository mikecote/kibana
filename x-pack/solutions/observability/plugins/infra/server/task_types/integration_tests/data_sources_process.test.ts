/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import { OBSERVABILITY_LOGS_DATA_ACCESS_LOG_SOURCES_ID } from '@kbn/management-settings-ids';
import { configSchema as sourcesConfigSchema } from '@kbn/apm-sources-access-plugin/server';
import { contribution as apmSourcesContribution } from '@kbn/apm-sources-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as apmContribution } from '@kbn/apm-data-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as logsContribution } from '@kbn/logs-data-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as metricsContribution } from '@kbn/metrics-data-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as infraContribution } from '../workflow_services_contribution';
import {
  MetricsDataClient,
  metricsDataSourceSavedObjectName,
} from '@kbn/metrics-data-access-plugin/server';
import { createInfraSources } from '../../lib/alerting/create_infra_alerting_libs';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const sourceIndices = sourcesConfigSchema.validate({}).indices;
const outputSchema = z.object({
  apmTransaction: z.string(),
  apmMetric: z.string(),
  metrics: z.string(),
  logs: z.array(z.string()),
  defaultHandlerOwner: z.string(),
});
const stepSchema = z.union([
  z.object({ output: outputSchema }).transform(({ output }) => output),
  outputSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native data sources in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          apmSourcesAccessRuntime: { indices: sourceIndices },
          apmDataAccessRuntime: { enabled: true },
          logsDataAccessRuntime: { enabled: true },
          metricsDataAccessRuntime: { defaultHandler: { installed: true, owner: 'infra' } },
        },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/data_sources_contribution.ts')],
        },
        seedContributions: {
          'workflow-steps': [
            apmSourcesContribution,
            apmContribution,
            logsContribution,
            metricsContribution,
            infraContribution,
          ],
        },
        workflows: {
          read: { steps: [{ name: 'sources', type: 'test.observability.data_sources', with: {} }] },
          ...Object.fromEntries(
            (['sources', 'metric_override', 'clear_override'] as const).map((mutation) => [
              mutation,
              {
                steps: [
                  { name: 'sources', type: 'test.observability.data_sources', with: { mutation } },
                ],
              },
            ])
          ),
        },
        seed: async ({ host }) => {
          const client = host.savedObjects.getUnsafeInternalClient();
          await client.create(
            'apm-indices',
            { apmIndices: { transaction: 'initial-apm-*' }, isSpaceAware: true },
            { id: 'apm-indices' }
          );
          await createInfraSources({
            metricsClient: new MetricsDataClient(),
          }).createSourceConfiguration(client, 'default', { metricAlias: 'initial-infra-*' });
          await client.delete(metricsDataSourceSavedObjectName, 'default');
          if (!host.uiSettings) throw new Error('The fixture requires native UI settings');
          await host.uiSettings
            .asScopedToClient(client)
            .set(OBSERVABILITY_LOGS_DATA_ACCESS_LOG_SOURCES_ID, ['initial-logs-*']);
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });
    it('uses current native configuration and saved-object overrides without retaining earlier sources', async () => {
      const failure = jest.fn();
      const expected = {
        apmTransaction: 'initial-apm-*',
        apmMetric: sourceIndices.metric,
        metrics: 'initial-infra-*',
        logs: ['initial-logs-*'],
        defaultHandlerOwner: 'infra',
      };
      const seen = new Set<string>();
      for (const workflow of ['read', 'sources', 'read', 'metric_override', 'clear_override']) {
        if (workflow === 'sources')
          Object.assign(expected, {
            apmTransaction: 'updated-apm-*',
            metrics: 'updated-infra-*',
            logs: ['updated-logs-*'],
          });
        if (workflow === 'metric_override') expected.metrics = 'explicit-metrics-*';
        if (workflow === 'clear_override') expected.metrics = 'updated-infra-*';
        await harness.run(workflow, failure);
        const executions = await harness.executionsOf(workflow);
        const fresh = executions.filter(({ id }) => !seen.has(id));
        expect(fresh).toHaveLength(1);
        const [completed] = fresh;
        seen.add(completed.id);
        expect({ status: completed.status, error: completed.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const steps = await harness.stepsOf(completed.id);
        const step = steps.find(({ stepId }) => stepId === 'sources');
        expect(stepSchema.parse(step?.output)).toEqual(expected);
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 5);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
