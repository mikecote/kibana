/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import { coreMock } from '@kbn/core/server/mocks';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import { KibanaFeature } from '@kbn/features-plugin/common';
import { SLO_ALERTING_FEATURES } from '@kbn/rule-data-utils';
import {
  getAlertingAuthorizationTaskProcessSettings,
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { configSchema as sourcesConfigSchema } from '@kbn/apm-sources-access-plugin/server';
import { contribution as apmSourcesContribution } from '@kbn/apm-sources-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as apmDataContribution } from '@kbn/apm-data-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as metricsContribution } from '@kbn/metrics-data-access-plugin/server/task_types/workflow_services_contribution';
import { contribution as infraContribution } from '@kbn/infra-plugin/server/task_types/workflow_services_contribution';
import { createInfraSources } from '@kbn/infra-plugin/server/lib/alerting/create_infra_alerting_libs';
import { infraSourceConfigurationSavedObjectType } from '@kbn/infra-plugin/server/lib/sources/saved_object_type';
import { MetricsDataClient } from '@kbn/metrics-data-access-plugin/server';
import { metricsDataSourceSavedObjectType } from '@kbn/metrics-data-access-plugin/server/saved_objects/metrics_data_source';
import { contribution as alertsContribution } from '@kbn/rule-registry-plugin/server/task_types/workflow_services_contribution';
import { contribution as sloContribution } from '@kbn/slo-plugin/server/task_types/workflow_services_contribution';
import { sloBurnRateRuleType } from '@kbn/slo-plugin/server/lib/rules/slo_burn_rate/register';
import { contribution as mlContribution } from '@kbn/ml-plugin/server/task_types/workflow_services_contribution';
import { captureModuleFiles } from '@kbn/ml-plugin/server/models/data_recognizer/module_files';
import { getMlSavedObjectTypes } from '@kbn/ml-plugin/server/saved_objects';
import { dataViewSavedObjectType } from '@kbn/data-views-plugin/server';
import { contribution as dataViewsContribution } from '@kbn/workflows-execution-engine/server/task_types/data_views_runtime_contribution';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { config as apmConfig } from '..';
import { contribution as apmContribution } from '../task_types/workflow_services_contribution';

const APM_INDEX = 'native-apm-errors';
const METRICS_INDEX = 'native-infra-hosts';
const rule = sloBurnRateRuleType(coreMock.createSetup().http.basePath);
const feature = new KibanaFeature({
  id: 'slo',
  name: 'SLOs',
  app: ['slo'],
  category: DEFAULT_APP_CATEGORIES.observability,
  alerting: SLO_ALERTING_FEATURES,
  privileges: {
    all: { savedObject: { all: [], read: [] }, ui: [] },
    read: { savedObject: { all: [], read: [] }, ui: [] },
  },
});
const resultSchema = z.object({
  message: z.string(),
  hosts: z.array(z.string()),
  cpu: z.number().nullable(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native APM and Infra providers in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      if (!apmConfig.schema) throw new Error('The native APM startup schema is required');
      const config = apmConfig.schema.validate(
        { searchAggregatedTransactions: 'never' },
        { serverless: false }
      );
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        savedObjectTypes: [
          dataViewSavedObjectType,
          infraSourceConfigurationSavedObjectType,
          metricsDataSourceSavedObjectType,
          ...getMlSavedObjectTypes(),
        ],
        settings: {
          apmSourcesAccessRuntime: {
            indices: { ...sourcesConfigSchema.validate({}).indices, error: APM_INDEX },
          },
          apmDataAccessRuntime: { enabled: true },
          metricsDataAccessRuntime: { defaultHandler: { installed: true, owner: 'infra' } },
          apmWorkflowRuntime: { config, mlEnabled: true, sloEnabled: true },
          infraWorkflowRuntime: { mlEnabled: true, spacesEnabled: true },
          sloRuntime: { enabled: true, spacesEnabled: true },
          dataViewsRuntime: {
            scriptedFieldsEnabled: false,
            rollupsEnabled: false,
            dataTiersExcludedForFields: true,
            fieldListCachingEnabled: true,
          },
          dataSearchRuntime: {
            multiSearchDocLink: coreMock.createSetup().docLinks.links.apis.multiSearch,
          },
          observabilityUiSettingsRuntime: { enabled: true },
          mlWorkflowRuntime: {
            enabledFeatures: { ad: true, dfa: true, nlp: true },
            compatibleModuleType: null,
            spacesEnabled: true,
            cpsEnabled: false,
            cloud: { isInTrial: false },
            moduleFiles: await captureModuleFiles(),
          },
          [ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID]:
            getAlertingAuthorizationTaskProcessSettings({
              ruleTypeRegistry: { list: () => new Map([[rule.id, rule]]) },
              features: { getKibanaFeatures: () => [feature] },
              spacesEnabled: true,
              securityEnabled: true,
            }),
        },
        seedContributions: {
          'workflow-steps': [
            apmSourcesContribution,
            apmDataContribution,
            metricsContribution,
            infraContribution,
            apmContribution,
            alertsContribution,
            sloContribution,
            mlContribution,
            dataViewsContribution,
          ],
        },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/native_data_providers_contribution.ts')],
        },
        workflows: {
          providers: {
            steps: [{ name: 'providers', type: 'test.observability.native_providers', with: {} }],
          },
        },
        seed: async ({ host, es }) => {
          await es.indices.create({
            index: '.internal.alerts-observability.slo.alerts-default-000001',
            aliases: { '.alerts-observability.slo.alerts-default': {} },
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'host.name': { type: 'keyword' },
                'kibana.alert.rule.rule_type_id': { type: 'keyword' },
                'kibana.space_ids': { type: 'keyword' },
                'kibana.alert.status': { type: 'keyword' },
              },
            },
          });
          await es.indices.create({
            index: APM_INDEX,
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'timestamp.us': { type: 'long' },
                id: { type: 'keyword' },
                'error.id': { type: 'keyword' },
                'error.grouping_key': { type: 'keyword' },
                'service.name': { type: 'keyword' },
                'agent.name': { type: 'keyword' },
                'processor.event': { type: 'keyword' },
                'processor.name': { type: 'keyword' },
              },
            },
          });
          await es.index({
            index: APM_INDEX,
            id: 'native-error-document',
            refresh: 'wait_for',
            document: {
              '@timestamp': new Date().toISOString(),
              timestamp: { us: Date.now() * 1000 },
              id: 'native-apm-error',
              error: {
                id: 'native-apm-error',
                grouping_key: 'native-group',
                exception: [{ message: 'Native APM failure', type: 'Error', handled: false }],
              },
              service: { name: 'checkout' },
              agent: { name: 'nodejs' },
              processor: { event: 'error', name: 'error' },
            },
          });
          await es.indices.create({
            index: METRICS_INDEX,
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'host.name': { type: 'keyword' },
                'event.module': { type: 'keyword' },
                'event.dataset': { type: 'keyword' },
                'metricset.module': { type: 'keyword' },
                'system.cpu.total.norm.pct': { type: 'double' },
              },
            },
          });
          await es.index({
            index: METRICS_INDEX,
            id: 'native-host',
            refresh: 'wait_for',
            document: {
              '@timestamp': new Date().toISOString(),
              host: { name: 'native-host' },
              event: { module: 'system', dataset: 'system.cpu' },
              metricset: { module: 'system' },
              system: { cpu: { total: { norm: { pct: 0.25 } } } },
            },
          });
          const client = host.savedObjects.getUnsafeInternalClient();
          await createInfraSources({
            metricsClient: new MetricsDataClient(),
          }).createSourceConfiguration(client, 'default', { metricAlias: METRICS_INDEX });
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });
    it('uses native error lookup and host aggregations while retaining current documents and one warm worker', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      for (const [message, cpu] of [
        ['Native APM failure', 0.25],
        ['Updated APM failure', 0.5],
        ['Native APM failure', 0.25],
      ] as const) {
        await harness.es.update({
          index: APM_INDEX,
          id: 'native-error-document',
          refresh: 'wait_for',
          doc: { error: { exception: [{ message, type: 'Error', handled: false }] } },
        });
        await harness.es.update({
          index: METRICS_INDEX,
          id: 'native-host',
          refresh: 'wait_for',
          doc: { system: { cpu: { total: { norm: { pct: cpu } } } } },
        });
        await harness.run('providers', failure);
        const execution = (await harness.executionsOf('providers')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No native provider execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        expect(outputSchema.parse(step.output)).toEqual({ message, hosts: ['native-host'], cpu });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
