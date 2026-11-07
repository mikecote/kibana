/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from '@kbn/zod/v4';
import { coreMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { configSchema as agentBuilderConfig } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import {
  startLlmStub,
  call,
  withSkill,
  outputOf,
  FINAL_ANSWER,
} from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import {
  WORKFLOW_PROCESS_TEST_MODES,
  startWorkflowProcessHarness,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { configSchema as alertingConfig } from '@kbn/alerting-plugin/server/config';
import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server/config';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import type { WorkflowYaml } from '@kbn/workflows';
import {
  getManagedWorkflowDefinition,
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
} from '@kbn/workflows/managed';
import { computeManagedDefinitionHash } from '@kbn/workflows-management-plugin/server/services/managed_workflow_status';
import {
  ATTACK_DISCOVERY_ATTACHMENT_TYPE,
  ATTACK_DISCOVERY_VERDICT_ATTACHMENT_TYPE,
  DIAGNOSTIC_REPORT_ATTACHMENT_TYPE,
} from '../../../common/constants';
import { contribution as workflowContribution } from '../workflow_steps_contribution';
import { GET_WORKFLOW_HEALTH_CHECK_TOOL_ID } from '../../agent_builder/skills/tools/get_workflow_health_check_tool';
import { RUN_ATTACK_DISCOVERY_TOOL_ID } from '../../agent_builder/skills/tools/run_attack_discovery_tool';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONNECTOR = 'discovery-agent-model';
const READ = 'discovery-attachment';
const HEALTH = 'discovery-health';
const ASYNC = 'discovery-agent-background';
const SYNC = 'discovery-agent-sync';
const TITLE = 'Discovery attached by a worker';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Discovery Agent Builder in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    const workerLogs: string[] = [];
    const toolResults = (from: number) =>
      llm
        .toolResultsSince(from)
        .split('\n')
        .flatMap((line) => {
          const { response } = z.object({ response: z.string() }).parse(JSON.parse(line));
          const payload = response.replace(/^<tool_result>|<\/tool_result>$/g, '');
          return z
            .object({
              results: z.array(z.object({ type: z.string(), data: z.unknown().optional() })),
            })
            .parse(JSON.parse(payload)).results;
        });
    beforeAll(async () => {
      llm = await startLlmStub();
      const workerLogger = loggerMock.create();
      workerLogger.get.mockReturnValue(workerLogger);
      for (const level of ['warn', 'error'] as const) {
        workerLogger[level].mockImplementation((message) => {
          if (typeof message === 'string') workerLogs.push(message);
          else if (message instanceof Error) workerLogs.push(message.message);
        });
      }
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const env = coreMock.createPluginInitializerContext().env;
      const settings = {
        ...getExampleContributionSettings(contributions),
        discoveries: {
          connectorTimeout: 60_000,
          agentBuilder: {
            attachmentTypeIds: [
              ATTACK_DISCOVERY_ATTACHMENT_TYPE,
              ATTACK_DISCOVERY_VERDICT_ATTACHMENT_TYPE,
              DIAGNOSTIC_REPORT_ATTACHMENT_TYPE,
            ],
            skillIds: [
              'attack-discovery-alert-retrieval-builder',
              'attack-discovery-generator',
              'attack-discovery-workflow-troubleshooting',
            ],
          },
        },
        alerting: alertingConfig.validate({}),
        ruleRegistry: ruleRegistryConfig.schema.validate({}),
        workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: ['discoveries'] },
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: agentBuilderConfig.validate({}, { dev: false }),
          env: {
            ...env,
            packageInfo: {
              ...env.packageInfo,
              version: kibanaPackageJson.version,
              buildFlavor: 'traditional',
            },
          },
          getSearchInferenceEndpoints: () => undefined,
        }),
      };
      const ids = await collectRegisteredIds({
        contributions,
        settings,
        logger: loggerMock.create(),
      });
      harness = await startWorkflowProcessHarness({
        logger: workerLogger,
        mode,
        reuse,
        maxIdleProcesses: 3,
        includeRunTask: true,
        settings,
        parity: Object.entries(ids).map(([kind, registeredIds]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registeredIds,
        })),
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        seedContributions: {
          'agent-builder': contributions,
          'workflow-steps': [workflowContribution],
        },
        workflows: {
          [READ]: {
            steps: [
              {
                name: 'persist',
                type: 'security.attack-discovery.persistDiscoveries',
                with: {
                  alerts_context_count: 1,
                  anonymized_alerts: [],
                  api_config: { connector_id: CONNECTOR, action_type_id: '.gen-ai' },
                  generation_uuid: 'agent-attachment',
                  attack_discoveries: [
                    {
                      alert_ids: ['evidence-1'],
                      title: TITLE,
                      summary_markdown: 'Worker attachment evidence',
                      details_markdown: 'Stored discovery details',
                    },
                  ],
                },
              },
              {
                name: 'conversation',
                type: 'ai.conversation.create',
                with: { agent_id: 'elastic-ai-agent', title: TITLE },
              },
              {
                name: 'attach',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: '${{ steps.conversation.output.conversation_id }}',
                  type: ATTACK_DISCOVERY_ATTACHMENT_TYPE,
                  origin: '${{ steps.persist.output.persisted_discoveries[0].id }}',
                },
              },
              {
                name: 'read',
                type: 'ai.attachment.read',
                with: {
                  conversation_id: '${{ steps.conversation.output.conversation_id }}',
                  attachment_id: '${{ steps.attach.output.attachment_id }}',
                },
              },
            ],
          },
          [HEALTH]: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'create-conversation': true,
                with: {
                  message: withSkill(
                    'attack-discovery-workflow-troubleshooting',
                    call(GET_WORKFLOW_HEALTH_CHECK_TOOL_ID, { workflow_ids: [READ] })
                  ),
                },
              },
            ],
          },
          [SYNC]: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'create-conversation': true,
                with: {
                  message: withSkill(
                    'attack-discovery-generator',
                    call(RUN_ATTACK_DISCOVERY_TOOL_ID, {
                      mode: 'sync',
                      connector_id: CONNECTOR,
                      filter: { ids: { values: ['missing-alert'] } },
                    })
                  ),
                },
              },
            ],
          },
          [ASYNC]: {
            steps: [
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                'create-conversation': true,
                with: {
                  message: withSkill(
                    'attack-discovery-generator',
                    call(RUN_ATTACK_DISCOVERY_TOOL_ID, {
                      mode: 'async',
                      connector_id: CONNECTOR,
                      filter: { ids: { values: ['missing-alert'] } },
                    })
                  ),
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          await es.index({
            index: '.kibana',
            id: `config:${host.server.version}`,
            refresh: 'wait_for',
            document: {
              type: 'config',
              config: { buildNum: 1, 'securitySolution:enableAttackDiscoveryWorkflows': true },
              references: [],
            },
          });
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
            .create(
              'action',
              {
                name: CONNECTOR,
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
          for (const id of [
            ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
            ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
            ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
          ]) {
            const definition = getManagedWorkflowDefinition(id);
            if (!definition?.yaml) throw new Error(`Missing managed workflow ${id}`);
            await es.index({
              index: WORKFLOW_INDEX_NAME,
              id,
              refresh: 'wait_for',
              document: {
                name: id,
                enabled: true,
                valid: true,
                spaceId: 'default',
                yaml: definition.yaml,
                definition: parse(definition.yaml) as WorkflowYaml,
                managed: true,
                managedBy: 'discoveries',
                managedVersion: definition.version,
                definitionHash: computeManagedDefinitionHash(definition),
                createdBy: 'elastic',
                lastUpdatedBy: 'elastic',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            });
          }
          await es.index({
            index: '.kibana-elastic-ai-assistant-anonymization-fields-default',
            id: 'host',
            refresh: 'wait_for',
            document: { field: 'host.name', allowed: true, anonymized: true },
          });
          await es.indices.create({
            index: '.alerts-security.alerts-default',
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'kibana.alert.risk_score': { type: 'float' },
                'kibana.alert.workflow_status': { type: 'keyword' },
              },
            },
          });
        },
      });
    });
    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });

    it('resolves a persisted Discovery attachment from its origin', async () => {
      const failure = jest.fn();
      await harness.run(READ, failure);
      expect(failure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(READ);
      expect({ status: execution.status, error: execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const steps = await harness.stepsOf(execution.id);
      const read = steps.find(({ stepId }) => stepId === 'read');
      expect(JSON.stringify(outputOf(read))).toContain(TITLE);
    }, 120000);

    it('loads the troubleshooting skill and reads workflow health on successive runs', async () => {
      for (let run = 0; run < 2; run++) {
        const from = llm.requests.length;
        const failure = jest.fn();
        await harness.run(HEALTH, failure);
        expect(failure).not.toHaveBeenCalled();
        const executions = await harness.executionsOf(HEALTH);
        expect(executions).toHaveLength(run + 1);
        expect(executions.every(({ status }) => status === 'completed')).toBe(true);
        expect(toolResults(from)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              data: {
                workflows: expect.arrayContaining([
                  expect.objectContaining({ id: READ, found: true, valid: true }),
                ]),
              },
            }),
          ])
        );
        const steps = await harness.stepsOf(executions[0].id);
        expect(outputOf(steps[0]).message).toBe(FINAL_ANSWER);
      }
      expect(harness.getWorkerStats()).toMatchObject({ spawned: reuse ? 1 : 3, active: 0 });
    }, 120000);

    it('queues generation from the agent and completes it after the caller returns', async () => {
      const from = llm.requests.length;
      const failure = jest.fn();
      await harness.run(ASYNC, failure);
      const [execution] = await harness.executionsOf(ASYNC);
      expect({ status: execution.status, error: execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const pending = toolResults(from)
        .map(({ data }) =>
          z.object({ execution_uuid: z.uuid(), status: z.literal('pending') }).safeParse(data)
        )
        .find((result) => result.success);
      if (!pending?.success) throw new Error('Missing queued Discovery execution UUID');
      const uuid = pending.data.execution_uuid;
      const workflowId = `attack-discovery-${uuid}`;
      const task = await harness.waitForRunTask(workflowId);
      const running = harness.runTask('workflow:run', task, failure);
      const retrieval = await harness
        .waitForRunTask(ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID)
        .catch(async () => {
          const [background] = await harness.executionsOf(workflowId);
          throw new Error(
            JSON.stringify({
              status: background.status,
              error: background.error,
              logs: workerLogs
                .filter((line) =>
                  /flush.*fail|failed.*flush|could not report|before registering/i.test(line)
                )
                .slice(-10),
            })
          );
        });
      await Promise.all([running, harness.runTask('workflow:run', retrieval, failure)]);
      expect(failure).not.toHaveBeenCalled();
      const [background] = await harness.executionsOf(workflowId);
      expect({ status: background.status, error: background.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      expect(background).toMatchObject({
        managed: true,
        managedBy: 'discoveries',
        billable: false,
        isEphemeral: true,
      });
      expect(background.executedBy).toBe(execution.executedBy);
      expect(background.metadata.attackDiscovery).toEqual({
        executionUuid: uuid,
        source: 'agent_builder',
      });
      expect(background.context.output.result).toMatchObject({
        execution_uuid: uuid,
        status: 'completed',
        discovery_count: 0,
      });
      expect(harness.kibanaRequests).toEqual([]);
      expect(workerLogs.filter((line) => /flush.*fail|failed.*flush/i.test(line))).toEqual([]);
      expect(harness.getWorkerStats()).toMatchObject({ spawned: reuse ? 3 : 6, active: 0 });
    }, 120000);
    it('waits for a synchronous agent generation result through the authorized execution reader', async () => {
      const from = llm.requests.length;
      const failure = jest.fn();
      const parent = harness.run(SYNC, failure);
      const child = await harness.waitForRunTask(/^attack-discovery-/);
      const background = harness.runTask('workflow:run', child, failure);
      const retrieval = await harness.waitForRunTask(ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID);
      await Promise.all([parent, background, harness.runTask('workflow:run', retrieval, failure)]);
      expect(failure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(SYNC);
      expect({ status: execution.status, error: execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      expect(toolResults(from)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ status: 'completed', discovery_count: 0 }),
          }),
        ])
      );
      expect(harness.kibanaRequests).toEqual([]);
      expect(workerLogs.filter((line) => /flush.*fail|failed.*flush/i.test(line))).toEqual([]);
      expect(harness.getWorkerStats()).toMatchObject({ spawned: reuse ? 3 : 9, active: 0 });
    }, 120000);
    it('persists an asynchronous pipeline failure and flushes its failure event before reuse', async () => {
      await harness.es.indices.delete({
        index: '.kibana-elastic-ai-assistant-anonymization-fields-default',
      });
      const from = llm.requests.length;
      const failure = jest.fn();
      await harness.run(ASYNC, failure);
      const pending = toolResults(from)
        .map(({ data }) =>
          z.object({ execution_uuid: z.uuid(), status: z.literal('pending') }).safeParse(data)
        )
        .find((result) => result.success);
      if (!pending?.success) throw new Error('Missing queued Discovery execution UUID');
      const uuid = pending.data.execution_uuid;
      const workflowId = `attack-discovery-${uuid}`;
      const child = await harness.waitForRunTask(workflowId);
      await harness.runTask('workflow:run', child, failure);
      expect(failure).not.toHaveBeenCalled();
      const [background] = await harness.executionsOf(workflowId);
      expect(background.status).toBe('failed');
      expect(background.error.message).toContain('Anonymization fields must be configured');
      await harness.es.indices.refresh({ index: '.kibana-event-log-ds' });
      const events = await harness.es.search({
        index: '.kibana-event-log-ds',
        query: {
          bool: {
            filter: [
              { term: { 'kibana.alert.rule.execution.uuid': uuid } },
              { term: { 'event.action': 'generation-failed' } },
            ],
          },
        },
      });
      expect(events.hits.hits).toHaveLength(1);
      expect(
        workerLogs.filter((line) =>
          /before registering|could not report.*attack_discovery|flush.*fail|failed.*flush/i.test(
            line
          )
        )
      ).toEqual([]);
      await harness.es.index({
        index: '.kibana-elastic-ai-assistant-anonymization-fields-default',
        id: 'host',
        refresh: 'wait_for',
        document: { field: 'host.name', allowed: true, anonymized: true },
      });
      const recoveryFrom = llm.requests.length;
      const recovery = harness.run(SYNC, failure);
      const recoveryChild = await harness.waitForRunTask(/^attack-discovery-/);
      const recoveryBackground = harness.runTask('workflow:run', recoveryChild, failure);
      const retrieval = await harness.waitForRunTask(ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID);
      await Promise.all([
        recovery,
        recoveryBackground,
        harness.runTask('workflow:run', retrieval, failure),
      ]);
      expect(toolResults(recoveryFrom)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ status: 'completed', discovery_count: 0 }),
          }),
        ])
      );
      expect(failure).not.toHaveBeenCalled();
      expect(
        workerLogs.filter((line) =>
          /before registering|could not report.*attack_discovery|flush.*fail|failed.*flush/i.test(
            line
          )
        )
      ).toEqual([]);
      expect(harness.getWorkerStats()).toMatchObject({ spawned: reuse ? 3 : 14, active: 0 });
      expect(harness.kibanaRequests).toEqual([]);
    }, 120000);
  }
);
