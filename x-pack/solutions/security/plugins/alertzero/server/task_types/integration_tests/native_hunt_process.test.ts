/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { ALERTZERO_ENABLED_SETTING_ID } from '@kbn/alertzero-common';
import { CONTEXT_ENGINE_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { configSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import { contribution as agentBuilderWorkflowContribution } from '@kbn/agent-builder-plugin/server/task_types/workflow_steps_contribution';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import {
  AGENTS_INDEX,
  GLOBAL_SETTINGS_SAVED_OBJECT_TYPE,
} from '@kbn/fleet-plugin/server/constants';
import { GLOBAL_SETTINGS_ID } from '@kbn/fleet-plugin/common/constants';
import type { FleetPackageMetadataTaskProcessSettings } from '@kbn/fleet-plugin/server/package_metadata_task_process_settings';
import { getSavedObjectTypes } from '@kbn/fleet-plugin/server/saved_objects';
import { contribution as fleetWorkflowContribution } from '@kbn/fleet-plugin/server/task_types/workflow_services_contribution';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { packageReportOutputSchema } from '../../../common/step_types/package_report';
import { significantSecurityEventAttachmentDataSchema } from '../../../common/significant_security_event_schema';
import { buildHuntInvestigationConversationId } from '../../services/watches/hunt/common/hunt_investigation_id';
import { extendWorkflowTestMappings } from './fixtures/workflow_test_mappings';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const REPORT = 'native-hunt-report';
const RUN = 'native-hunt-run';
const CONVERSATION = buildHuntInvestigationConversationId({ spaceId: 'default', reportId: REPORT });
const ACTION = 'native-hunt-response';
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
const finding = significantSecurityEventAttachmentDataSchema.parse({
  title: 'Native confirmed host finding',
  severity: 'high',
  confidence: 0.9,
  status: 'open',
  source_watch: 'system-security-hunt-continuous-threat-hunt',
  capability: 'continuous_threat_hunt',
  run_id: RUN,
  report_id: REPORT,
  security_knowledge_indicators: [
    { type: 'technique', value: 'T1078.004', technique_id: 'T1078.004' },
  ],
  entities: [{ field: 'host.name', value: 'shared-host' }],
  timeline: [],
  hypothesis_tested: 'Compromised host',
  evidence_for: ['Tier 1 hit'],
  evidence_against: [],
  evaluation_record_ref: 'native-evaluation',
  hunt_result: {
    has_confirmed_hit: true,
    hit_sources: ['tier1'],
    time_range: { from: '2026-09-25T00:00:00.000Z', to: '2026-09-25T01:00:00.000Z' },
    tier1: {
      status: 'environment_hits_found',
      counts: { total_hits: 1, returned_hits: 1, affected_hosts: 1, affected_users: 0 },
      per_index: [{ index: 'logs-endpoint.events*', hit_count: 1, required: true }],
      resolved_iocs: [],
    },
  },
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native hunt packaging in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let deniedKey: string;
    beforeAll(async () => {
      const logger = loggingSystemMock.createLogger();
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const settings = {
        ...getExampleContributionSettings(contributions),
        fleetPackageMetadata: metadata,
        workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: ['alertzero'] },
        alertzero: {
          serviceAccountsEnabled: true,
          managedWorkflowsReady: true,
          telemetryOptedIn: false,
          searchInferenceEndpointsAvailable: false,
          actionsServiceAvailable: true,
          huntServicesReady: true,
          fleetAgentServiceAvailable: true,
        },
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: configSchema.validate({}, { dev: false }),
          env: coreMock.createPluginInitializerContext().env,
          getSearchInferenceEndpoints: () => undefined,
        }),
      };
      const ids = await collectRegisteredIds({ contributions, settings, logger });
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger,
        settings,
        seedContributions: {
          'agent-builder': contributions,
          'workflow-steps': [agentBuilderWorkflowContribution, fleetWorkflowContribution],
        },
        savedObjectTypes: [
          agentBuilderSpaceSettingsType,
          ...Object.values(getSavedObjectTypes({ useSpaceAwareness: true })),
        ],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          [ACTION]: { steps: [{ name: 'unused', type: 'console', with: { message: 'unused' } }] },
          journal: {
            steps: [
              {
                name: 'create',
                type: 'ai.conversation.create',
                with: {
                  conversation_id: CONVERSATION,
                  template_id: 'investigation',
                  title: 'Native hunt',
                },
              },
              {
                name: 'finding',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: CONVERSATION,
                  type: 'security.significant_security_event',
                  data: finding,
                },
              },
            ],
          },
          package: {
            steps: [
              {
                name: 'package',
                type: 'hunt.packageReport',
                with: {
                  spaceId: 'default',
                  reportId: REPORT,
                  investigationConversationId: CONVERSATION,
                  runId: RUN,
                  huntStatus: 'success',
                  hasConfirmedHit: true,
                  expectedSseCount: 1,
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          await host.savedObjects.getUnsafeInternalClient().create(
            'config',
            {
              'agentBuilder:experimentalFeatures': true,
              [ALERTZERO_ENABLED_SETTING_ID]: true,
              [CONTEXT_ENGINE_ENABLED_SETTING_ID]: false,
              buildNum: 1,
            },
            { id: kibanaPackageJson.version, overwrite: true }
          );
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: [GLOBAL_SETTINGS_SAVED_OBJECT_TYPE] })
            .create(
              GLOBAL_SETTINGS_SAVED_OBJECT_TYPE,
              { use_space_awareness_migration_status: 'success' },
              { id: GLOBAL_SETTINGS_ID }
            );
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Hunt proof requires native Security');
          const privilege = 'hunt_without_proposals_read';
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                [privilege]: {
                  application: 'kibana-.kibana',
                  name: privilege,
                  actions: [
                    security.authz.actions.login,
                    security.authz.actions.savedObject.get('*', '*'),
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
          deniedKey = key.encoded;
          await extendWorkflowTestMappings(es);
          await es.update({
            index: WORKFLOW_INDEX_NAME,
            id: ACTION,
            refresh: 'wait_for',
            doc: {
              managed: true,
              managedBy: 'alertzero',
              spaceId: GLOBAL_WORKFLOW_SPACE_ID,
              tags: ['action'],
              definition: {
                consts: {
                  actionMetadata: {
                    name: 'Native host response',
                    category: 'respond',
                    approvalPolicy: 'autonomy-dependent',
                  },
                },
                triggers: [
                  {
                    type: 'manual',
                    inputs: {
                      type: 'object',
                      properties: { endpoint_ids: { type: 'array', items: { type: 'string' } } },
                      required: ['endpoint_ids'],
                    },
                  },
                ],
              },
            },
          });
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
                agent: { id, version: '9.6.0' },
                local_metadata: { host: { hostname: 'shared-host', name: 'shared-host' } },
              },
            });
          }
        },
      });
    }, 300000);
    afterAll(async () => harness?.stop());
    it('packages native evidence using current scoped enrollment and the native action catalog and proposal service', async () => {
      const failure = jest.fn();
      await harness.run('journal', failure);
      expect(await harness.executionsOf('journal')).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      const seen = new Set<string>();
      for (const [active, denied] of [
        [true, false],
        [true, true],
        [false, false],
        [true, false],
      ] as const) {
        await harness.es.update({
          index: AGENTS_INDEX,
          id: 'default-agent',
          refresh: 'wait_for',
          doc: { active },
        });
        await harness.run('package', failure, { apiKey: denied ? deniedKey : harness.apiKey });
        const execution = (await harness.executionsOf('package')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No packaging execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        const output = packageReportOutputSchema.parse(step.output);
        expect(output.status).toBe('packaged');
        if (output.status !== 'packaged') throw new Error('Hunt did not package its finding');
        if (denied) {
          expect(output.mintSuppression).toBe('check_failed');
          expect(output.proposals).toEqual([]);
          expect(output.expectedProposalCount).toBe(0);
          continue;
        }
        expect(output.mintSuppression).toBe('none');
        expect(output.expectedProposalCount).toBe(1);
        expect(output.proposals).toHaveLength(1);
        expect(output.proposals[0]).toMatchObject(
          active
            ? {
                actionWorkflowId: ACTION,
                actionInput: { endpoint_ids: ['default-agent'] },
                hostName: 'shared-host',
              }
            : { title: 'Analyst recommendation' }
        );
        if (!active) expect(output.proposals[0].actionWorkflowId).toBeUndefined();
        expect(output.coverage.written).toEqual([]);
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 5);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
