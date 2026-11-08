/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { z } from '@kbn/zod/v4';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { configSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import {
  call,
  startLlmStub,
} from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

import { IMPACT_INDEX_NAME, SET_IMPACT_TOOL_ID } from '../../../common/impact/constants';
import {
  HYPOTHESES_INDEX_NAME,
  SET_HYPOTHESES_TOOL_ID,
} from '../../../common/hypotheses/constants';
import { impactSchema } from '../../../common/impact/impact';
import { investigationHypothesesSchema } from '../../../common/hypotheses/hypotheses';
import { contribution as stepsContribution } from '../workflow_steps_contribution';
import { createInvestigationDocumentServices } from '../../services/create_document_services';
import { subjectDocumentId } from '../../subjects/services/subjects_service';
import { SUBJECT_ATTACHMENT_TYPE } from '../../../common/subjects/constants';
import {
  INVESTIGATIONS_API_PRIVILEGE_READ,
  INVESTIGATIONS_API_PRIVILEGE_MANAGE,
} from '../../investigations/constants';
import { AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID } from '../agentic_investigations_task_process_settings';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONVERSATION_ID = randomUUID();
const CONNECTOR = 'investigations-model';
const SUBJECT_ID = subjectDocumentId('default', CONVERSATION_ID, {
  type: 'manual',
  id: 'question-1',
});
const SUBJECT_SUMMARY = 'Why is checkout failing?';
const ENTITY = { id: 'checkout', name: 'Checkout', type: 'service' };
const SUMMARY = 'Checkout failures affect customers in the primary region.';
const HYPOTHESIS = {
  candidate: 'The upstream database is saturated',
  confidence: 0.8,
  status: 'investigating',
};
const outputSchema = z.union([
  z.object({ output: z.record(z.string(), z.json()) }).transform(({ output }) => output),
  z.record(z.string(), z.json()),
]);
const readImpactStep = {
  name: 'impact_read',
  type: 'investigations.getImpact',
  with: { conversationId: CONVERSATION_ID },
};
const followupSteps = [
  {
    name: 'subject_read',
    type: 'ai.attachment.read',
    with: { conversation_id: CONVERSATION_ID, attachment_id: SUBJECT_ID },
  },
  readImpactStep,
  {
    name: 'append',
    type: 'investigations.appendWorkflowExecutionId',
    with: { conversationId: CONVERSATION_ID, workflowExecutionId: 'worker-execution' },
  },
  { name: 'reopen', type: 'investigations.reopen', with: { conversationId: CONVERSATION_ID } },
  {
    name: 'metadata',
    type: 'ai.conversation.metadata.read',
    with: { conversation_id: CONVERSATION_ID },
  },
  { name: 'attachments', type: 'ai.attachment.list', with: { conversation_id: CONVERSATION_ID } },
  {
    name: 'query_clients',
    type: 'test.investigations.queryClients',
    with: { conversationId: CONVERSATION_ID, subjectId: 'question-1' },
  },
];

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Agentic investigations in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    const logs: string[] = [];
    let limitedKey: string;
    let otherUserKey: string;
    beforeAll(async () => {
      llm = await startLlmStub();
      const logger = loggingSystemMock.createLogger();
      for (const level of ['warn', 'error'] as const)
        logger[level].mockImplementation((message) => {
          if (typeof message === 'string') logs.push(message);
        });
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const settings = {
        ...getExampleContributionSettings(contributions),
        [AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID]: {
          escalationsEnabled: true,
          securityEnabled: true,
          spacesEnabled: true,
          proposalsEnabled: true,
        },
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: configSchema.validate({}, { dev: false }),
          env: coreMock.createPluginInitializerContext().env,
          getSearchInferenceEndpoints: () => undefined,
        }),
      };
      const ids = await collectRegisteredIds({ contributions, settings, logger });
      harness = await startWorkflowProcessHarness({
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/query_clients_steps_contribution.ts')],
        },
        mode,
        reuse,
        logger,
        settings,
        seedContributions: {
          'agent-builder': contributions,
          'workflow-steps': [stepsContribution],
        },
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          create: {
            steps: [
              {
                name: 'create',
                type: 'ai.conversation.create',
                with: {
                  conversation_id: CONVERSATION_ID,
                  template_id: 'investigation',
                  title: 'Worker investigation',
                  access_control: { access_mode: 'private' },
                  metadata: { status: 'closed' },
                },
              },
              {
                name: 'subject',
                type: 'ai.attachment.add',
                with: {
                  conversation_id: CONVERSATION_ID,
                  id: SUBJECT_ID,
                  type: SUBJECT_ATTACHMENT_TYPE,
                  origin: SUBJECT_ID,
                },
              },
              {
                name: 'attach',
                type: 'investigations.attachImpact',
                with: { conversationId: CONVERSATION_ID, entities: [ENTITY] },
              },
              {
                name: 'agent',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                with: {
                  conversation_id: CONVERSATION_ID,
                  configuration_overrides: {
                    enable_elastic_capabilities: false,
                    tools: [{ tool_ids: [SET_IMPACT_TOOL_ID, SET_HYPOTHESES_TOOL_ID] }],
                  },
                  message: [
                    call(SET_IMPACT_TOOL_ID, { summary: SUMMARY }),
                    call(SET_HYPOTHESES_TOOL_ID, { hypotheses: [HYPOTHESIS] }),
                  ].join('\n'),
                },
              },
              ...followupSteps,
            ],
          },
          followup: { steps: followupSteps },
          denied_query: {
            steps: [
              {
                name: 'query_clients',
                type: 'test.investigations.queryClients',
                with: { conversationId: CONVERSATION_ID, subjectId: 'question-1' },
              },
            ],
          },
          denied_read: { steps: [readImpactStep] },
          denied_write: {
            steps: [
              {
                name: 'attach',
                type: 'investigations.attachImpact',
                with: { conversationId: CONVERSATION_ID, entities: [{ id: 'unauthorized' }] },
              },
            ],
          },
        },
        seed: async ({ host, es }) => {
          await createInvestigationDocumentServices({
            esClient: host.elasticsearch.asInternalUser,
            logger,
          })
            .subjectsService.getDocumentService()
            .upsert({
              id: SUBJECT_ID,
              mutate: () => ({
                spaceId: 'default',
                conversationId: CONVERSATION_ID,
                subjectType: 'manual',
                subjectId: 'question-1',
                summary: SUBJECT_SUMMARY,
                createdAt: new Date().toISOString(),
              }),
            });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Investigations requires native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                worker_without_investigations: {
                  application: 'kibana-.kibana',
                  name: 'worker_without_investigations',
                  actions: [actions.login, actions.savedObject.get('*', '*')],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'worker-without-investigations',
            role_descriptors: {
              worker: {
                cluster: [],
                indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['worker_without_investigations'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          limitedKey = key.encoded;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                worker_investigator: {
                  application: 'kibana-.kibana',
                  name: 'worker_investigator',
                  actions: [
                    actions.login,
                    actions.savedObject.get('*', '*'),
                    actions.api.get(INVESTIGATIONS_API_PRIVILEGE_READ),
                    actions.api.get(INVESTIGATIONS_API_PRIVILEGE_MANAGE),
                  ],
                },
              },
            },
          });
          await es.security.putRole({
            name: 'worker-investigator',
            indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
            applications: [
              {
                application: 'kibana-.kibana',
                privileges: ['worker_investigator'],
                resources: ['*'],
              },
            ],
          });
          await es.security.putUser({
            username: 'other-investigator',
            password: 'fixture-password',
            roles: ['worker-investigator'],
          });
          const otherKey = await es.security.grantApiKey({
            grant_type: 'password',
            username: 'other-investigator',
            password: 'fixture-password',
            api_key: { name: 'other-investigator' },
          });
          otherUserKey = otherKey.encoded;

          await host.savedObjects
            .getUnsafeInternalClient()
            .create(
              'config',
              { 'agentBuilder:experimentalFeatures': true, buildNum: 1 },
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
              { id: CONNECTOR }
            );
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });
    it('persists investigation data and reuses authorized conversation services without calling Kibana', async () => {
      const failure = jest.fn();
      for (const workflow of ['create', 'followup']) {
        await harness.run(workflow, failure);
        const [execution] = await harness.executionsOf(workflow);
        expect({ status: execution.status, error: execution.error, logs }).toEqual({
          status: 'completed',
          error: undefined,
          logs: expect.any(Array),
        });
        const steps = await harness.stepsOf(execution.id);
        const outputs = Object.fromEntries(
          steps
            .filter(({ stepId }) => followupSteps.some(({ name }) => name === stepId))
            .map(({ stepId, output }) => [stepId, outputSchema.parse(output)])
        );
        expect(outputs.subject_read).toEqual({
          version: expect.any(Number),
          data: expect.objectContaining({
            id: SUBJECT_ID,
            conversationId: CONVERSATION_ID,
            summary: SUBJECT_SUMMARY,
          }),
        });
        expect(outputs.query_clients).toEqual({
          id: CONVERSATION_ID,
          listedIds: expect.arrayContaining([CONVERSATION_ID]),
          openIds: expect.arrayContaining([CONVERSATION_ID]),
          subjectIds: [SUBJECT_ID],
        });
        expect(outputs.impact_read).toEqual({ id: expect.any(String), entities: [ENTITY] });
        expect(outputs.reopen).toEqual(
          workflow === 'create'
            ? { reopened: true, title: '[Reopen] Worker investigation' }
            : { reopened: false, title: '[Reopen] Worker investigation' }
        );
        expect(outputs.metadata).toEqual({
          metadata: expect.objectContaining({
            status: 'open',
            workflow_execution_ids: ['worker-execution'],
          }),
        });
        expect(outputs.attachments).toEqual(
          expect.objectContaining({
            attachments: expect.arrayContaining([
              expect.objectContaining({ type: 'investigation_impact' }),
              expect.objectContaining({ type: 'investigation_subject' }),
              expect.objectContaining({ type: 'investigation_hypotheses' }),
            ]),
          })
        );
        if (workflow === 'create') {
          for (const deniedWorkflow of ['denied_read', 'denied_write', 'denied_query']) {
            await harness.run(deniedWorkflow, failure, { apiKey: limitedKey });
            const [denied] = await harness.executionsOf(deniedWorkflow);
            expect(denied.status).toBe('failed');
            expect(denied.error?.message).toContain('Missing privilege');
          }
          for (const deniedWorkflow of ['denied_read', 'denied_write', 'denied_query']) {
            await harness.run(deniedWorkflow, failure, {
              apiKey: otherUserKey,
              userName: 'other-investigator',
            });
            const denials = await harness.executionsOf(deniedWorkflow);
            expect(denials.map(({ status, error }) => ({ status, error }))).toEqual(
              expect.arrayContaining([
                {
                  status: 'failed',
                  error: expect.objectContaining({ message: expect.stringMatching(/not found/i) }),
                },
              ])
            );
          }
        }
      }
      await harness.es.indices.refresh({ index: [IMPACT_INDEX_NAME, HYPOTHESES_INDEX_NAME] });
      const impacts = await harness.es.search({
        index: IMPACT_INDEX_NAME,
        query: { match_all: {} },
      });
      expect(
        impacts.hits.hits.map(({ _source }) => impactSchema.omit({ id: true }).parse(_source))
      ).toEqual([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          spaceId: 'default',
          summary: SUMMARY,
          entities: [ENTITY],
          createdBy: expect.objectContaining({ username: 'elastic' }),
        }),
      ]);
      const hypotheses = await harness.es.search({
        index: HYPOTHESES_INDEX_NAME,
        query: { match_all: {} },
      });
      expect(
        hypotheses.hits.hits.map(({ _source }) =>
          investigationHypothesesSchema.omit({ id: true }).parse(_source)
        )
      ).toEqual([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          spaceId: 'default',
          hypotheses: [HYPOTHESIS],
        }),
      ]);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 8);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 180000);
  }
);
