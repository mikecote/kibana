/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { z } from '@kbn/zod/v4';
import type {
  AgentBuilderContribution,
  AgentBuilderContributionStart,
} from '@kbn/agent-builder-server';
import { platformSignificantEventsTools } from '@kbn/agent-builder-common';
import { coreMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { NIGHTSHIFT_ENABLED_FLAG } from '@kbn/nightshift-shared';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { configSchema as agentBuilderConfigSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import {
  call,
  withSkill,
  startLlmStub,
} from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { configSchema as alertingV2ConfigSchema } from '@kbn/alerting-v2-plugin/server/config';
import { getAlertingV2SavedObjectTypes } from '@kbn/alerting-v2-plugin/server/saved_objects';
import { DatastreamInitializer } from '@kbn/alerting-v2-plugin/server/lib/services/resource_service/datastream_initializer';
import { getDataStreamResourceDefinitions } from '@kbn/alerting-v2-plugin/server/resources/datastreams/register';
import { contribution as alertingV2WorkflowContribution } from '@kbn/alerting-v2-plugin/server/task_types/workflow_steps_contribution';
import { contribution as sourcesContribution } from '@kbn/nightshift-sources-plugin/server/task_types/workflow_services_contribution';
import {
  nightshiftSourceSavedObjectType,
  NIGHTSHIFT_SOURCE_SO_TYPE,
} from '@kbn/nightshift-sources-plugin/server/saved_objects/nightshift_source_saved_object';

import { createSystemClient } from '@kbn/agent-builder-plugin/server/services/agents/persisted/client';
import { agentsIndexName } from '@kbn/agent-builder-plugin/server/services/agents/persisted/client/storage';

import { contribution } from '../agent_builder_contribution';
import {
  installDiscoveryAgents,
  SIGNIFICANT_EVENTS_DISCOVERY_AGENT_ID,
} from '../../agent_builder/agents/discovery';
import { installFeatureIdentificationAgent } from '../../agent_builder/agents/feature_identification';
import { installKIQueryGenerationAgent } from '../../agent_builder/agents/ki_query_generation';
import { eventsWriteSchema } from '../../agent_builder/tools/event_write/tool';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONNECTOR = 'significant-events-model';
const TITLE = 'Event created by a workflow worker';
const toolResponseSchema = z.object({
  results: z.array(
    z.object({
      type: z.string(),
      data: z
        .object({
          message: z.string().optional(),
          results: z
            .array(
              z.object({
                written: z.boolean(),
                event_id: z.string().optional(),
                error: z.object({ reason: z.string() }).optional(),
              })
            )
            .optional(),
          total: z.number().optional(),
          knowledge_indicators: z.array(z.object({})).optional(),
          events: z
            .array(z.object({ title: z.string(), source_ids: z.array(z.string()) }))
            .optional(),
        })
        .optional(),
    })
  ),
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Significant Events in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    const logs: string[] = [];
    let limitedKey: string;
    const flags = { [NIGHTSHIFT_ENABLED_FLAG]: true };
    const resultsSince = (from: number) =>
      llm
        .toolResultsSince(from)
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          const envelope = z.object({ response: z.string() }).parse(JSON.parse(line));
          const payload = envelope.response.replace(/^<tool_result>|<\/tool_result>$/g, '').trim();
          if (!payload.startsWith('{')) {
            return [{ type: 'error', data: { message: payload } }];
          }
          return toolResponseSchema.parse(JSON.parse(payload)).results;
        });

    beforeAll(async () => {
      llm = await startLlmStub();
      const logger = loggerMock.create();
      logger.get.mockReturnValue(logger);
      for (const level of ['warn', 'error'] as const)
        logger[level].mockImplementation((message) => {
          if (typeof message === 'string') logs.push(message);
        });
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const config = alertingV2ConfigSchema.validate({});
      const settings = {
        ...getExampleContributionSettings(contributions),
        alertingV2Runtime: { config, agentBuilderEnabled: true, smlEnabled: true },
        nightshiftSourcesRuntime: { enabled: true },
        fieldsMetadataRuntime: {},
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: agentBuilderConfigSchema.validate({}, { dev: false }),
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
        featureFlags: flags,
        seedContributions: {
          'agent-builder': contributions,
          'workflow-steps': [alertingV2WorkflowContribution, sourcesContribution],
        },
        savedObjectTypes: [
          ...getAlertingV2SavedObjectTypes(),
          agentBuilderSpaceSettingsType,
          nightshiftSourceSavedObjectType,
          ...(contribution.declares?.savedObjectTypes ?? []),
        ],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          knowledge: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'agent-id': SIGNIFICANT_EVENTS_DISCOVERY_AGENT_ID,
                with: {
                  message: call(platformSignificantEventsTools.searchKnowledgeIndicators, {
                    slugs: ['logs'],
                  }),
                },
              },
            ],
          },
          confirmation: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                with: {
                  message: withSkill(
                    'significant-events-management',
                    call(platformSignificantEventsTools.createEvent, {
                      title: TITLE,
                      summary: 'A native event persisted from a task process',
                      symptom_hypothesis:
                        'Requests fail because an upstream dependency is unavailable.',
                      slugs: ['logs'],
                      confidence: 0.8,
                      status: 'active',
                      severity: 'low',
                    })
                  ),
                },
              },
            ],
          },
          create: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'agent-id': SIGNIFICANT_EVENTS_DISCOVERY_AGENT_ID,
                with: {
                  message: call(
                    platformSignificantEventsTools.eventsWrite,
                    eventsWriteSchema.parse({
                      items: [
                        {
                          title: TITLE,
                          summary: 'A native event persisted from a task process',
                          symptom_hypothesis:
                            'Requests fail because an upstream dependency is unavailable.',
                          slugs: ['logs'],
                          confidence: 0.8,
                          severity: 'high',
                          assessment_note: 'Verified through a workflow',
                          causal_features: [],
                          blast_radius: [],
                          signals: [
                            {
                              type: 'detection',
                              source_id: 'logs',
                              description:
                                'Requests fail because an upstream dependency is unavailable.',
                              verdict: 'confirms',
                              evidence: {
                                esql_query: 'FROM logs-*',
                                result: 'found',
                              },
                              metadata: {
                                rule_uuid: 'rule-fixture',
                                detection_id: 'detection-fixture',
                                change_point_type: 'spike',
                                p_value: 0.01,
                              },
                            },
                          ],
                        },
                      ],
                    })
                  ),
                },
              },
            ],
          },
          search: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'agent-id': SIGNIFICANT_EVENTS_DISCOVERY_AGENT_ID,
                with: {
                  message: call(platformSignificantEventsTools.searchEvent, {
                    query: TITLE,
                    view: 'compact',
                  }),
                },
              },
            ],
          },
        },
        seed: async ({ host, es }) => {
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Significant Events requires native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                worker_without_nightshift: {
                  application: 'kibana-.kibana',
                  name: 'worker_without_nightshift',
                  actions: [actions.login, actions.savedObject.get('*', '*')],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'worker-without-nightshift',
            role_descriptors: {
              worker: {
                cluster: [],
                indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['worker_without_nightshift'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          limitedKey = key.encoded;
          for (const definition of getDataStreamResourceDefinitions(config.retention)) {
            await new DatastreamInitializer(
              logger,
              host.elasticsearch.asInternalUser,
              definition
            ).initialize();
          }
          const systemAgents = createSystemClient({
            space: 'default',
            elasticsearch: { client: host.elasticsearch },
            logger,
          });
          const agentBuilder: Pick<AgentBuilderContributionStart, 'agents'> = {
            agents: { ensure: async ({ agent }) => systemAgents.ensureAgent(agent) },
          };
          await Promise.all([
            installDiscoveryAgents({ agentBuilder, spaceId: 'default' }),
            installFeatureIdentificationAgent({ agentBuilder, spaceId: 'default' }),
            installKIQueryGenerationAgent({ agentBuilder, spaceId: 'default' }),
          ]);
          await host.elasticsearch.asInternalUser.indices.refresh({ index: agentsIndexName });
          const client = host.savedObjects.getUnsafeInternalClient();
          await client.create(
            'config',
            { 'agentBuilder:experimentalFeatures': true, buildNum: 1 },
            { id: kibanaPackageJson.version, overwrite: true }
          );
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: [NIGHTSHIFT_SOURCE_SO_TYPE] })
            .create(
              NIGHTSHIFT_SOURCE_SO_TYPE,
              {
                title: 'Logs',
                esql: 'FROM logs-*',
                type: 'logs',
                tags: [],
                slug: 'logs',
                view_name: '$.nightshift.sources.default.logs',
                enabled: true,
                created_by: 'elastic',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                esql_updated_at: new Date().toISOString(),
              },
              { id: 'source-1' }
            );
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
            .create(
              'action',
              {
                name: 'stub model',
                actionTypeId: '.gen-ai',
                isMissingSecrets: false,
                config: {
                  apiProvider: 'OpenAI',
                  apiUrl: `${llm.url}/v1/chat/completions`,
                  defaultModel: 'gpt-4',
                },
                secrets: { apiKey: 'test-key' },
              },
              { id: CONNECTOR }
            );
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });
    it('creates and reads an event through native Agent Builder tools without calling Kibana', async () => {
      const failure = jest.fn();
      const confirmationFrom = llm.requests.length;
      await harness.run('confirmation', failure);
      expect(
        resultsSince(confirmationFrom)
          .filter(({ type }) => type === 'error')
          .map(({ data }) => data?.message)
      ).toEqual([
        'Agent running in non-interactive mode, user input not available - execution was declined',
      ]);
      expect((await harness.es.count({ index: '.rule-events*' })).count).toBe(0);
      const before = llm.requests.length;
      await harness.run('create', failure);
      const [created] = await harness.executionsOf('create');
      expect({ status: created.status, error: created.error, logs }).toEqual({
        status: 'completed',
        error: undefined,
        logs: expect.any(Array),
      });
      const writes = resultsSince(before);
      expect(
        writes.filter(({ type }) => type === 'error').map(({ data }) => data?.message)
      ).toEqual([]);
      expect(writes.flatMap(({ data }) => data?.results ?? [])).toEqual([
        expect.objectContaining({ written: true, event_id: expect.any(String) }),
      ]);
      const searchFrom = llm.requests.length;
      await harness.run('search', failure);
      const [searched] = await harness.executionsOf('search');
      expect({ status: searched.status, error: searched.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const reads = resultsSince(searchFrom);
      expect(reads.filter(({ type }) => type === 'error').map(({ data }) => data?.message)).toEqual(
        []
      );
      expect(reads.flatMap(({ data }) => data?.events ?? [])).toEqual([
        expect.objectContaining({ title: TITLE, source_ids: ['source-1'] }),
      ]);
      const stored = await harness.es.search({
        index: '.rule-events*',
        size: 100,
        query: { match_all: {} },
      });
      expect(JSON.stringify(stored.hits.hits)).toContain(TITLE);
      const deniedWriteFrom = llm.requests.length;
      await harness.run('create', failure, { apiKey: limitedKey });
      expect(resultsSince(deniedWriteFrom).filter(({ type }) => type === 'error')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.stringContaining('Nightshift manage privilege'),
          }),
        }),
      ]);
      expect((await harness.es.count({ index: '.rule-events*' })).count).toBe(1);
      const deniedReadFrom = llm.requests.length;
      await harness.run('search', failure, { apiKey: limitedKey });
      expect(resultsSince(deniedReadFrom).filter(({ type }) => type === 'error')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.stringContaining('Nightshift read privilege'),
          }),
        }),
      ]);
      const knowledgeFrom = llm.requests.length;
      await harness.run('knowledge', failure);
      const knowledge = resultsSince(knowledgeFrom);
      expect(knowledge.filter(({ type }) => type === 'error')).toEqual([]);
      expect(knowledge.map(({ data }) => data)).toEqual([
        expect.objectContaining({ total: 0, knowledge_indicators: [] }),
      ]);
      flags[NIGHTSHIFT_ENABLED_FLAG] = false;
      const disabledFrom = llm.requests.length;
      await harness.run('search', failure);
      const disabled = (await harness.executionsOf('search')).find(
        ({ status }) => status === 'failed'
      );
      expect(disabled?.error?.message).toContain('not available');
      expect(llm.requests.length).toBe(disabledFrom);
      flags[NIGHTSHIFT_ENABLED_FLAG] = true;
      const restoredFrom = llm.requests.length;
      await harness.run('search', failure);
      expect(resultsSince(restoredFrom).flatMap(({ data }) => data?.events ?? [])).toEqual([
        expect.objectContaining({ title: TITLE, source_ids: ['source-1'] }),
      ]);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 8);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
