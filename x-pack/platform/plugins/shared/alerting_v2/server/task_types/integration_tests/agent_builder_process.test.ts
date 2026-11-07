/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * @jest-environment node
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import {
  RULE_ATTACHMENT_TYPE,
  ACTION_POLICY_ATTACHMENT_TYPE,
  ALERT_ATTACHMENT_TYPE,
} from '@kbn/alerting-v2-schemas';
import { ALERTING_TOOL_IDS, RULE_AUTHORING_SKILL_ID } from '@kbn/alerting-v2-constants';
import { loggerMock } from '@kbn/logging-mocks';
import { AGENTBUILDER_USAGE_DOMAIN } from '@kbn/agent-builder-plugin/server/telemetry/usage_counters';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { configSchema as agentBuilderConfigSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import {
  getAgentBuilderRunSettings,
  AGENT_BUILDER_RUN_SETTINGS_ID,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import {
  call,
  withSkill,
  FINAL_ANSWER,
  outputOf,
  startLlmStub,
} from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import { configSchema } from '../../config';
import { getAlertingV2SavedObjectTypes } from '../../saved_objects';
import { createChangeHistoryClient } from '../../lib/rule_changes_history/create_change_history_client';
import { RuleCreatedTriggerId } from '../../../common/workflows/triggers';
import { DatastreamInitializer } from '../../lib/services/resource_service/datastream_initializer';
import { getDataStreamResourceDefinitions } from '../../resources/datastreams/register';
import { ALERTING_V2_TASK_PROCESS_SETTINGS_ID } from '../task_process_settings';
import { contribution as workflowContribution } from '../workflow_steps_contribution';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (kind: string) => string[];
};
const INDEX = 'parity-v2-metrics';
const CONNECTOR_ID = 'v2-agent-connector';
const DRAFT_NAME = 'Draft created in a task worker';

const operations = [
  { operation: 'set_metadata', name: DRAFT_NAME },
  { operation: 'set_kind', kind: 'alert' },
  { operation: 'set_schedule', every: '1m', lookback: '5m' },
  { operation: 'set_query', query: { base: `FROM ${INDEX} | WHERE value > 0` } },
  { operation: 'set_recovery', recovery: { strategy: 'manual' } },
  { operation: 'set_no_data', no_data: { strategy: 'ignore' } },
];

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Alerting v2 Agent Builder in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    const workerLogs: string[] = [];

    beforeAll(async () => {
      llm = await startLlmStub();
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const config = configSchema.validate({});
      const workerLogger = loggerMock.create();
      workerLogger.get.mockReturnValue(workerLogger);
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        workerLogger[level].mockImplementation((message) => {
          if (typeof message === 'string') workerLogs.push(message);
          else if (message instanceof Error) workerLogs.push(message.message);
        });
      }
      const settings = {
        ...getExampleContributionSettings(contributions),
        [ALERTING_V2_TASK_PROCESS_SETTINGS_ID]: {
          config,
          agentBuilderEnabled: true,
          smlEnabled: true,
        },
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: agentBuilderConfigSchema.validate({}, { dev: false }),
          env: {
            packageInfo: { version: kibanaPackageJson.version, buildFlavor: 'traditional' },
            airgapped: false,
          } as never,
          getSearchInferenceEndpoints: () => undefined,
        }),
      };
      const ids = await collectRegisteredIds({
        contributions,
        settings,
        logger: loggerMock.create(),
      });
      expect(ids.attachmentTypes).toContain(RULE_ATTACHMENT_TYPE);
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger: workerLogger,
        settings,
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/client_contribution.ts')],
        },
        seedContributions: {
          'agent-builder': contributions,
          'workflow-steps': [workflowContribution],
        },
        savedObjectTypes: [...getAlertingV2SavedObjectTypes(), agentBuilderSpaceSettingsType],
        parity: Object.entries(ids).map(([kind, registeredIds]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registeredIds,
        })),
        workflows: {
          'on-rule-created': {
            triggers: [{ type: RuleCreatedTriggerId }],
            steps: [{ name: 'triggered', type: 'console', with: { message: 'created' } }],
          },
          read: {
            steps: [
              { name: 'create', type: 'test.alerting_v2.create', with: {} },
              {
                name: 'inspect_episode',
                type: 'test.alerting_v2.inspect_episode',
                with: { id: '{{ steps.create.output.episodeId }}' },
              },
              {
                name: 'conversation',
                type: 'ai.conversation.create',
                with: { agent_id: 'elastic-ai-agent', title: 'Stored rule' },
              },
              {
                name: 'attach',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: '{{ steps.conversation.output.conversation_id }}',
                  type: RULE_ATTACHMENT_TYPE,
                  origin: '{{ steps.create.output.ruleId }}',
                },
              },
              {
                name: 'policy',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: '{{ steps.conversation.output.conversation_id }}',
                  type: ACTION_POLICY_ATTACHMENT_TYPE,
                  origin: '{{ steps.create.output.policyId }}',
                },
              },
              {
                name: 'episode',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: '{{ steps.conversation.output.conversation_id }}',
                  type: ALERT_ATTACHMENT_TYPE,
                  origin: '{{ steps.create.output.episodeId }}',
                },
              },
              {
                name: 'read',
                type: 'ai.attachment.read',
                with: {
                  conversation_id: '{{ steps.conversation.output.conversation_id }}',
                  attachment_id: '{{ steps.attach.output.attachment_id }}',
                },
              },
            ],
          },
          author: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR_ID,
                'create-conversation': true,
                with: {
                  message: withSkill(
                    RULE_AUTHORING_SKILL_ID,
                    call(ALERTING_TOOL_IDS.manageRule, { operations })
                  ),
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          for (const definition of getDataStreamResourceDefinitions(config.retention)) {
            await new DatastreamInitializer(
              loggerMock.create(),
              es as never,
              definition
            ).initialize();
          }
          await es.indices.create({
            index: INDEX,
            mappings: { properties: { '@timestamp': { type: 'date' }, value: { type: 'double' } } },
          });
          await es.index({
            index: INDEX,
            document: { '@timestamp': new Date().toISOString(), value: 1 },
            refresh: true,
          });
          if (!host.userProfile) throw new Error('The fixture requires user profile services');
          await createChangeHistoryClient({
            logger: loggerMock.create(),
            kibanaVersion: kibanaPackageJson.version,
          }).initialize(host.elasticsearch.asInternalUser, {
            userProfileService: host.userProfile,
          });
          await host.savedObjects.getUnsafeInternalClient().create(
            'config',
            {
              'agentBuilder:experimentalFeatures': true,
              buildNum: 1,
            },
            { id: kibanaPackageJson.version, overwrite: true }
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
              { id: CONNECTOR_ID }
            );
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });

    it('resolves a persisted rule attachment through the shared request-scoped client graph', async () => {
      const failure = jest.fn();
      await harness.run('read', failure);
      expect(failure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('read');
      const inspected = (await harness.stepsOf(execution.id)).find(
        ({ stepId }) => stepId === 'inspect_episode'
      );
      expect(inspected).toBeDefined();
      expect({ error: execution.error, episode: outputOf(inspected) }).toEqual({
        error: undefined,
        episode: { authorized: true, episode: expect.any(Object) },
      });
      expect(execution.status).toBe('completed');
      const step = (await harness.stepsOf(execution.id)).find(({ stepId }) => stepId === 'read');
      expect(step).toBeDefined();
      expect(JSON.stringify(step?.output)).toContain('Persisted universal rule');
      const create = (await harness.stepsOf(execution.id)).find(
        ({ stepId }) => stepId === 'create'
      );
      const { ruleId } = outputOf(create);
      const systemRequest = { headers: { 'x-elastic-product-origin': 'kibana' } };
      await harness.es.indices.refresh({ index: '.kibana_change_history' }, systemRequest);
      const history = await harness.es.search(
        { index: '.kibana_change_history', query: { term: { 'object.id': ruleId } } },
        systemRequest
      );
      expect(history.hits.hits).toHaveLength(1);
      const triggered = await harness.waitForRunTask('on-rule-created');
      expect(triggered).toBeDefined();
    });

    it('authors and persists a rule draft with the skill tool in ai.agent', async () => {
      const failure = jest.fn();
      const from = llm.requests.length;
      await harness.run('author', failure);
      expect(failure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('author');
      expect(execution.status).toBe('completed');
      const agent = (await harness.stepsOf(execution.id)).find(({ stepId }) => stepId === 'agent');
      expect(outputOf(agent).message).toBe(FINAL_ANSWER);
      expect(llm.toolResultsSince(from)).toContain(DRAFT_NAME);
      const conversationId = outputOf(agent).conversation_id;
      await harness.es.indices.refresh({ index: '.chat-conversations' });
      const { hits } = await harness.es.search<Record<string, object>>({
        index: '.chat-conversations',
        query: { term: { _id: conversationId } },
      });
      expect(hits.hits).toHaveLength(1);
      expect(JSON.stringify(hits.hits[0]._source)).toContain(DRAFT_NAME);
      expect(JSON.stringify(hits.hits[0]._source)).toContain(RULE_ATTACHMENT_TYPE);
      await harness.es.indices.refresh({ index: '.kibana_usage_counters' });
      const counters = await harness.es.count({
        index: '.kibana_usage_counters',
        query: { term: { 'usage-counter.domainId': AGENTBUILDER_USAGE_DOMAIN } },
      });
      expect(counters.count).toBeGreaterThan(0);
    });

    it('uses the requested worker lifetime without calling Kibana', () => {
      expect({
        spawned: harness.getWorkerStats().spawned,
        errors: workerLogs.filter((line) =>
          /flush failed|flushing did not|cleanup.*fail/i.test(line)
        ),
      }).toEqual({ spawned: reuse ? 1 : 2, errors: [] });
      expect(harness.getWorkerStats().active).toBe(0);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
