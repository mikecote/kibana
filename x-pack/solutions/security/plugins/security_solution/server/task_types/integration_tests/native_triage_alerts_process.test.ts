/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { prefetchChangedListFieldIds } from '../../lib/detection_engine/routes/common/operations/prefetch_previous_statuses';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import {
  WORKFLOWS_EVENTS_DATA_STREAM,
  WorkflowsManagementOperationPrivileges,
} from '@kbn/workflows';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { contribution as spacesContribution } from '@kbn/workflows-extensions/server/spaces_runtime_contribution';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { ALERTS_API_READ } from '@kbn/security-solution-features/constants';
import { DEFAULT_ALERTS_INDEX } from '../../../common/constants';
import {
  SECURITY_ALERTS_SETTINGS_ID,
  type SecurityAlertsTaskProcessSettings,
} from '../security_alerts_settings';
import { AlertTagsChangedTriggerId } from '../../../common/workflows/triggers';
import type { TriggerEventDocument } from '@kbn/workflows-execution-engine/server/trigger_events/event_logs/trigger_events_data_stream';
import { TRIAGE_PENDING_TAG } from '@kbn/alertzero-plugin/server/alert_triage/constants';
import { extendWorkflowTestMappings } from '@kbn/alertzero-plugin/server/task_types/integration_tests/fixtures/workflow_test_mappings';

const alertsIndex = `${DEFAULT_ALERTS_INDEX}-default`;
const foreignIndex = `${DEFAULT_ALERTS_INDEX}-foreign-space`;
const metadata: SecurityAlertsTaskProcessSettings = {
  searchIndexName: DEFAULT_ALERTS_INDEX,
  signalsIndex: '.siem-signals',
  appClientInitialized: true,
  kibanaBranch: 'main',
  buildFlavor: 'traditional',
  workflowEventsAvailable: true,
};
const load = {
  steps: [
    {
      name: 'load',
      type: 'alertzero.triage.loadAlerts',
      with: { alert_ids: ['fresh', 'missing'] },
    },
  ],
};

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native triage alerts in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    const logger = loggingSystemMock.createLogger();
    let deniedKey: string;
    let readerKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger,
        savedObjectTypes: spacesContribution.declares?.savedObjectTypes,
        seedContributions: { 'workflow-steps': [spacesContribution] },
        settings: {
          [SECURITY_ALERTS_SETTINGS_ID]: metadata,
          workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: ['alertzero'] },
          alertzero: {
            serviceAccountsEnabled: true,
            managedWorkflowsReady: true,
            searchInferenceEndpointsAvailable: false,
            actionsServiceAvailable: true,
            huntServicesReady: true,
            fleetAgentServiceAvailable: false,
            telemetryOptedIn: false,
          },
        },
        workflows: {
          batch: { steps: [{ name: 'done', type: 'console', with: { message: 'Unused batch' } }] },
          load,
          'foreign-load': load,
          sweep: {
            steps: [
              {
                name: 'sweep',
                type: 'alertzero.triage.planSweep',
                with: {
                  batch_workflow_id: 'batch',
                  analysis_tag_prefix: 'ai-triage:',
                  budget_per_hour: 600,
                  interval_minutes: 10,
                  lookback_hours: 24,
                  min_severity: 'high',
                  exclude_building_blocks: true,
                  excluded_rule_tags: ['EXCLUDE'],
                  headroom: { status: 'ok', in_flight: 0, slots: 40 },
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          await extendWorkflowTestMappings(es);
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['space'] })
            .create(
              'space',
              { name: 'Foreign space', disabledFeatures: [] },
              { id: 'foreign-space' }
            );
          await es.update({
            index: WORKFLOW_INDEX_NAME,
            id: 'foreign-load',
            refresh: 'wait_for',
            doc: { spaceId: 'foreign-space' },
          });
          for (const index of [alertsIndex, foreignIndex]) {
            await es.indices.create({
              index,
              mappings: {
                properties: {
                  '@timestamp': { type: 'date' },
                  marker: { type: 'keyword' },
                  'kibana.alert.rule.uuid': { type: 'keyword' },
                  'kibana.alert.rule.name': { type: 'keyword' },
                  'kibana.alert.rule.tags': { type: 'keyword' },
                  'kibana.alert.risk_score': { type: 'double' },
                  'kibana.alert.workflow_status': { type: 'keyword' },
                  'kibana.alert.workflow_tags': { type: 'keyword' },
                  'kibana.alert.severity': { type: 'keyword' },
                  'kibana.alert.building_block_type': { type: 'keyword' },
                },
              },
            });
          }
          for (const id of ['fresh', 'aged', 'closed', 'low', 'building-block', 'excluded']) {
            await es.index({
              index: alertsIndex,
              id,
              refresh: 'wait_for',
              document: {
                '@timestamp': new Date(
                  Date.now() - (id === 'aged' ? 48 * 60 * 60 * 1000 : 0)
                ).toISOString(),
                marker: 'local',
                'kibana.alert.rule.uuid': 'rule-main',
                'kibana.alert.rule.name': 'Native rule',
                'kibana.alert.risk_score': 90,
                'kibana.alert.workflow_status': id === 'closed' ? 'closed' : 'open',
                'kibana.alert.workflow_tags': [],
                'kibana.alert.severity': id === 'low' ? 'low' : 'high',
                'kibana.alert.rule.tags': id === 'excluded' ? ['EXCLUDE'] : [],
                ...(id === 'building-block'
                  ? { 'kibana.alert.building_block_type': 'default' }
                  : {}),
              },
            });
          }
          await es.index({
            index: foreignIndex,
            id: 'fresh',
            refresh: 'wait_for',
            document: {
              '@timestamp': new Date().toISOString(),
              marker: 'foreign',
              'kibana.alert.rule.uuid': 'foreign-rule',
              'kibana.alert.rule.name': 'Foreign rule',
              'kibana.alert.risk_score': 100,
              'kibana.alert.workflow_status': 'open',
              'kibana.alert.workflow_tags': [],
              'kibana.alert.severity': 'high',
            },
          });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Native alerts proof requires Security');
          for (const [privilege, read] of [
            ['native_alerts_reader', true],
            ['native_alerts_without_read', false],
          ] as const) {
            await es.security.putPrivileges({
              body: {
                'kibana-.kibana': {
                  [privilege]: {
                    application: 'kibana-.kibana',
                    name: privilege,
                    actions: [
                      security.authz.actions.login,
                      security.authz.actions.savedObject.get('*', '*'),
                      ...WorkflowsManagementOperationPrivileges.readExecution.map((action) =>
                        security.authz.actions.api.get(action)
                      ),
                      ...(read ? [security.authz.actions.api.get(ALERTS_API_READ)] : []),
                    ],
                  },
                },
              },
            });
            const key = await es.security.createApiKey({
              name: privilege,
              role_descriptors: {
                native: {
                  cluster: [],
                  indices: [{ names: ['.*'], privileges: ['all'], allow_restricted_indices: true }],
                  applications: [
                    { application: 'kibana-.kibana', privileges: [privilege], resources: ['*'] },
                  ],
                },
              },
            });
            if (read) readerKey = key.encoded;
            else deniedKey = key.encoded;
          }
        },
      });
    }, 300000);
    afterAll(async () => harness?.stop());
    it('reads scoped documents, preserves filters and authorization, persists claims and native trigger lineage without Kibana calls', async () => {
      const failure = jest.fn();
      const seen = new Set<string>();
      const run = async (workflowId: string, apiKey = harness.apiKey) => {
        await harness.run(workflowId, failure, { apiKey });
        const execution = (await harness.executionsOf(workflowId)).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No native alerts execution was persisted');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        return { execution, step };
      };
      const loaded = await run('load');
      expect(loaded.execution).toMatchObject({ status: 'completed' });
      expect(loaded.step.output).toMatchObject({
        missing_alert_ids: ['missing'],
        alerts: [
          {
            _id: 'fresh',
            _index: alertsIndex,
            marker: 'local',
            kibana: { alert: { rule: { uuid: 'rule-main' } } },
          },
        ],
      });
      expect(
        await prefetchChangedListFieldIds(
          harness.es,
          alertsIndex,
          ['fresh'],
          'kibana.alert.workflow_tags',
          [TRIAGE_PENDING_TAG],
          [],
          [TRIAGE_PENDING_TAG],
          []
        )
      ).toEqual({ changedIds: ['fresh'], actualAdded: [TRIAGE_PENDING_TAG], actualRemoved: [] });
      const first = await run('sweep');
      expect({ status: first.execution.status, error: first.execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      expect(first.step.output).toMatchObject({
        skip_reason: 'none',
        batches: [{ rule_id: 'rule-main', alert_ids: ['fresh'] }],
        numbers: { aged_out_alerts: 1, planned_alerts: 1 },
      });
      const denied = await run('load', deniedKey);
      expect(denied.execution.status).toBe('failed');
      await harness.es.update({
        index: alertsIndex,
        id: 'fresh',
        refresh: 'wait_for',
        doc: { 'kibana.alert.workflow_tags': [] },
      });
      const readonly = await run('sweep', readerKey);
      expect(readonly.execution.status).toBe('failed');
      const unchanged = await harness.es.get<{ 'kibana.alert.workflow_tags': string[] }>({
        index: alertsIndex,
        id: 'fresh',
      });
      expect(unchanged._source?.['kibana.alert.workflow_tags']).toEqual([]);
      const restored = await run('sweep');
      expect(restored.execution).toMatchObject({ status: 'completed' });
      const claimed = await harness.es.get<{ 'kibana.alert.workflow_tags': string[] }>({
        index: alertsIndex,
        id: 'fresh',
      });
      expect(claimed._source?.['kibana.alert.workflow_tags']).toEqual([TRIAGE_PENDING_TAG]);
      const foreign = await harness.es.get<{ 'kibana.alert.workflow_tags': string[] }>({
        index: foreignIndex,
        id: 'fresh',
      });
      expect(foreign._source?.['kibana.alert.workflow_tags']).toEqual([]);
      const eventsIndex = WORKFLOWS_EVENTS_DATA_STREAM;
      const kibanaEs = harness.es.child({ headers: { 'x-elastic-product-origin': 'kibana' } });
      await kibanaEs.indices.refresh({ index: eventsIndex, expand_wildcards: 'all' });
      const events = await kibanaEs.search<TriggerEventDocument>({
        index: eventsIndex,
        expand_wildcards: 'all',
        query: { term: { triggerId: AlertTagsChangedTriggerId } },
        size: 10,
      });
      expect(
        logger.warn.mock.calls.filter(([message]) => String(message).includes('Failed'))
      ).toEqual([]);
      expect(events.hits.hits).toHaveLength(2);
      expect(new Set(events.hits.hits.map(({ _source }) => _source?.sourceExecutionId))).toEqual(
        new Set([first.execution.id, restored.execution.id])
      );
      for (const event of events.hits.hits)
        expect(event._source).toMatchObject({
          spaceId: 'default',
          payload: {
            alertIds: ['fresh'],
            tagsAdded: [TRIAGE_PENDING_TAG],
            tagsRemoved: [],
            truncated: false,
          },
        });
      await harness.runTask(
        'workflow:scheduled',
        {
          id: 'workflow:foreign-load:scheduled',
          params: {
            workflowId: 'foreign-load',
            spaceId: 'foreign-space',
            triggerType: 'scheduled',
          },
        },
        failure,
        { apiKey: harness.apiKey, spaceId: 'foreign-space' }
      );
      const [foreignExecution] = await harness.executionsOf('foreign-load');
      expect(foreignExecution).toMatchObject({ status: 'completed', spaceId: 'foreign-space' });
      const [foreignStep] = await harness.stepsOf(foreignExecution.id);
      expect(foreignStep.output).toMatchObject({
        alerts: [
          {
            _id: 'fresh',
            _index: foreignIndex,
            marker: 'foreign',
            kibana: { alert: { rule: { uuid: 'foreign-rule' } } },
          },
        ],
      });
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 6);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
