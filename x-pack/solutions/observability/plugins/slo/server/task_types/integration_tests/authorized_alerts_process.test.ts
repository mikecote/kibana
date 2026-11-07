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
import {
  ALERT_RULE_TYPE_ID,
  ALERT_RULE_CONSUMER,
  ALERT_RULE_PRODUCER,
  ALERT_RULE_UUID,
  ALERT_UUID,
  ALERT_STATUS,
  ALERT_WORKFLOW_STATUS,
  SPACE_IDS,
  SLO_ALERTING_FEATURES,
} from '@kbn/rule-data-utils';
import {
  getAlertingAuthorizationTaskProcessSettings,
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { AlertingAuthorizationEntity, ReadOperations } from '@kbn/alerting-plugin/server';
import { contribution as alertsContribution } from '@kbn/rule-registry-plugin/server/task_types/workflow_services_contribution';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { sloBurnRateRuleType } from '../../lib/rules/slo_burn_rate/register';

const nativeRule = sloBurnRateRuleType(coreMock.createSetup().http.basePath);
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
const alias = '.alerts-observability.slo.alerts-default';
const index = '.internal.alerts-observability.slo.alerts-default-000001';
const operations = [
  'read',
  'denied_write',
  'denied_read',
  'close',
  'readonly',
  'feature_off',
  'feature_restore',
  'read',
] as const;
const resultSchema = z.object({
  aliases: z.array(z.string()).optional(),
  ids: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  error: z.string().optional(),
  forbidden: z.boolean().optional(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native authorized alerts in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let readOnlyKey: string;
    let deniedKey: string;
    const snapshot = getAlertingAuthorizationTaskProcessSettings({
      ruleTypeRegistry: { list: () => new Map([[nativeRule.id, nativeRule]]) },
      features: { getKibanaFeatures: () => [feature] },
      spacesEnabled: true,
      securityEnabled: true,
    });
    const nativeFeatures = snapshot.features;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: { [ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID]: snapshot },
        seedContributions: { 'workflow-steps': [alertsContribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/authorized_alerts_contribution.ts')],
        },
        workflows: {
          read: { steps: [{ name: 'alerts', type: 'test.slo.authorized_alerts', with: {} }] },
          close: {
            steps: [{ name: 'alerts', type: 'test.slo.authorized_alerts', with: { close: true } }],
          },
        },
        seed: async ({ es, host }) => {
          await es.indices.create({
            index,
            aliases: { [alias]: {} },
            mappings: {
              properties: {
                [ALERT_RULE_TYPE_ID]: { type: 'keyword' },
                [ALERT_RULE_CONSUMER]: { type: 'keyword' },
                [ALERT_RULE_PRODUCER]: { type: 'keyword' },
                [ALERT_RULE_UUID]: { type: 'keyword' },
                [ALERT_UUID]: { type: 'keyword' },
                [ALERT_STATUS]: { type: 'keyword' },
                [ALERT_WORKFLOW_STATUS]: { type: 'keyword' },
                [SPACE_IDS]: { type: 'keyword' },
              },
            },
          });
          for (const [id, space] of [
            ['native-slo-alert', 'default'],
            ['other-space-alert', 'operations'],
          ]) {
            await es.index({
              index,
              id,
              refresh: 'wait_for',
              document: {
                [ALERT_RULE_TYPE_ID]: nativeRule.id,
                [ALERT_RULE_CONSUMER]: 'slo',
                [ALERT_RULE_PRODUCER]: 'slo',
                [ALERT_RULE_UUID]: 'native-slo-rule',
                [ALERT_UUID]: id,
                [ALERT_STATUS]: 'active',
                [ALERT_WORKFLOW_STATUS]: 'open',
                [SPACE_IDS]: [space],
                '@timestamp': new Date().toISOString(),
              },
            });
          }
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Authorized alerts require native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                slo_alert_read: {
                  application: 'kibana-.kibana',
                  name: 'slo_alert_read',
                  actions: [
                    actions.login,
                    actions.alerting.get(
                      nativeRule.id,
                      'slo',
                      AlertingAuthorizationEntity.Alert,
                      ReadOperations.Find
                    ),
                    actions.alerting.get(
                      nativeRule.id,
                      'slo',
                      AlertingAuthorizationEntity.Alert,
                      ReadOperations.Get
                    ),
                  ],
                },
                slo_alert_denied: {
                  application: 'kibana-.kibana',
                  name: 'slo_alert_denied',
                  actions: [actions.login],
                },
              },
            },
          });
          for (const name of ['slo_alert_read', 'slo_alert_denied']) {
            const key = await es.security.createApiKey({
              name,
              role_descriptors: {
                native: {
                  cluster: [],
                  indices: [],
                  applications: [
                    { application: 'kibana-.kibana', privileges: [name], resources: ['*'] },
                  ],
                },
              },
            });
            if (name === 'slo_alert_read') readOnlyKey = key.encoded;
            else deniedKey = key.encoded;
          }
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
    });

    it('preserves native read and write authorization, space filtering and changing dispatch metadata', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      let closed = false;
      for (const operation of operations) {
        if (operation === 'feature_off') snapshot.features = [];
        if (operation === 'feature_restore') snapshot.features = nativeFeatures;
        const workflow = operation === 'denied_write' || operation === 'close' ? 'close' : 'read';
        const key =
          operation === 'denied_write' || operation === 'readonly'
            ? readOnlyKey
            : operation === 'denied_read'
            ? deniedKey
            : undefined;
        await harness.run(workflow, failure, key ? { apiKey: key } : undefined);
        const executions = (await harness.executionsOf(workflow)).filter(({ id }) => !seen.has(id));
        expect(executions).toHaveLength(1);
        const [execution] = executions;
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const step = (await harness.stepsOf(execution.id)).find(
          ({ stepId }) => stepId === 'alerts'
        );
        const output = outputSchema.parse(step?.output);
        if (operation === 'denied_write') {
          expect(output.forbidden).toBe(true);
          expect(output.ids).toBeUndefined();
        } else if (operation === 'denied_read' || operation === 'feature_off') {
          expect(output).toEqual({
            error: expect.stringContaining('Unauthorized to find alerts for any rule types.'),
            forbidden: false,
          });
        } else {
          if (operation === 'close') closed = true;
          expect(output).toEqual({
            aliases: [alias],
            ids: ['native-slo-alert'],
            statuses: [closed ? 'closed' : 'open'],
          });
        }
        if (operation === 'readonly') expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 5);
        const stored = await harness.es.get<{ [ALERT_WORKFLOW_STATUS]: string }>({
          index,
          id: 'native-slo-alert',
        });
        expect(stored._source?.[ALERT_WORKFLOW_STATUS]).toBe(closed ? 'closed' : 'open');
        const other = await harness.es.get<{ [ALERT_WORKFLOW_STATUS]: string }>({
          index,
          id: 'other-space-alert',
        });
        expect(other._source?.[ALERT_WORKFLOW_STATUS]).toBe('open');
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 3 : operations.length);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
