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
import {
  ALERTZERO_ENABLED_SETTING_ID,
  ALERTZERO_FRONTIER_INFERENCE_FEATURE_ID,
} from '@kbn/alertzero-common';
import { GEN_AI_SETTINGS_DEFAULT_AI_CONNECTOR } from '@kbn/management-settings-ids';
import { configSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import { contribution as agentBuilderWorkflowContribution } from '@kbn/agent-builder-plugin/server/task_types/workflow_steps_contribution';
import { registerInferenceFeatures } from '@kbn/agent-builder-plugin/server/inference_features';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { startLlmStub } from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import { InferenceFeatureRegistry } from '@kbn/search-inference-endpoints/server/inference_feature_registry';
import { createInferenceSettingsSavedObjectType } from '@kbn/search-inference-endpoints/server/saved_objects/inference_settings';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { registerAlertZeroInferenceFeatures } from '../../inference_features';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONNECTOR = 'alertzero-summary-model';
const DEFAULT_CONNECTOR = 'unselected-default-model';
const CONVERSATION = '6045281b-5037-4655-bc75-aad0e8b718a0';
const SUMMARY = 'The Okta admin rule fired and the analyst recorded it.';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native AlertZero summaries in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    let defaultLlm: Awaited<ReturnType<typeof startLlmStub>>;
    let deniedKey: string;

    beforeAll(async () => {
      llm = await startLlmStub({ getFinalAnswer: () => JSON.stringify({ summary: SUMMARY }) });
      defaultLlm = await startLlmStub({
        getFinalAnswer: () => JSON.stringify({ summary: 'Wrong connector' }),
      });
      const logger = loggingSystemMock.createLogger();
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const features = new InferenceFeatureRegistry(logger);
      const searchInferenceEndpoints = { features: { register: features.register.bind(features) } };
      registerInferenceFeatures({ searchInferenceEndpoints });
      registerAlertZeroInferenceFeatures(searchInferenceEndpoints, logger);
      const settings = {
        ...getExampleContributionSettings(contributions),
        inferenceFeatures: { features: features.getAll() },
        alertzero: {
          serviceAccountsEnabled: true,
          managedWorkflowsReady: true,
          telemetryOptedIn: false,
          searchInferenceEndpointsAvailable: true,
          actionsServiceAvailable: true,
          huntServicesReady: true,
          fleetAgentServiceAvailable: false,
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
          'workflow-steps': [agentBuilderWorkflowContribution],
        },
        savedObjectTypes: [agentBuilderSpaceSettingsType, createInferenceSettingsSavedObjectType()],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          journal: {
            steps: [
              {
                name: 'create',
                type: 'ai.conversation.create',
                with: {
                  conversation_id: CONVERSATION,
                  template_id: 'investigation',
                  title: 'Native summary conversation',
                },
              },
              {
                name: 'note',
                type: 'ai.conversation.add_user_message',
                with: {
                  conversation_id: CONVERSATION,
                  message: 'The Okta admin rule fired and the analyst recorded it.',
                },
              },
            ],
          },
          summary: {
            steps: [
              {
                name: 'summarize',
                type: 'alertzero.investigation.summarize',
                with: { conversation_id: CONVERSATION },
              },
              {
                name: 'read',
                type: 'ai.conversation.metadata.read',
                with: { conversation_id: CONVERSATION },
              },
            ],
          },
        },
        seed: async ({ host, es }) => {
          await host.savedObjects.getUnsafeInternalClient().create(
            'config',
            {
              'agentBuilder:experimentalFeatures': true,
              [GEN_AI_SETTINGS_DEFAULT_AI_CONNECTOR]: DEFAULT_CONNECTOR,
              [ALERTZERO_ENABLED_SETTING_ID]: true,
              buildNum: 1,
            },
            { id: kibanaPackageJson.version, overwrite: true }
          );
          const clients = host.savedObjects.getUnsafeInternalClient({
            includedHiddenTypes: ['action', 'inference-settings'],
          });
          for (const [id, url] of [
            [CONNECTOR, llm.url],
            [DEFAULT_CONNECTOR, defaultLlm.url],
          ]) {
            await clients.create(
              'action',
              {
                name: 'summary model',
                actionTypeId: '.gen-ai',
                isMissingSecrets: false,
                config: {
                  apiProvider: 'OpenAI',
                  apiUrl: `${url}/v1/chat/completions`,
                  defaultModel: 'gpt-4',
                },
                secrets: { apiKey: 'test-key' },
              },
              { id }
            );
          }
          await clients.create(
            'inference-settings',
            {
              features: [
                {
                  feature_id: ALERTZERO_FRONTIER_INFERENCE_FEATURE_ID,
                  endpoints: [{ id: CONNECTOR }],
                },
              ],
            },
            { id: 'default' }
          );
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Summary proof requires native Security');
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                summary_reader: {
                  application: 'kibana-.kibana',
                  name: 'summary_reader',
                  actions: [
                    security.authz.actions.login,
                    security.authz.actions.savedObject.get('*', '*'),
                  ],
                },
              },
            },
          });
          await es.security.putRole({
            name: 'summary-reader',
            indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
            applications: [
              { application: 'kibana-.kibana', privileges: ['summary_reader'], resources: ['*'] },
            ],
          });
          await es.security.putUser({
            username: 'other-summary-reader',
            password: 'fixture-password',
            roles: ['summary-reader'],
          });
          const key = await es.security.grantApiKey({
            grant_type: 'password',
            username: 'other-summary-reader',
            password: 'fixture-password',
            api_key: { name: 'summary-private-conversation-denied' },
          });
          deniedKey = key.encoded;
        },
      });
    }, 300000);

    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
      await defaultLlm?.stop();
    });

    it('persists a native structured summary and rechecks conversation access between runs', async () => {
      const failure = jest.fn();
      await harness.run('journal', failure);
      const [journal] = await harness.executionsOf('journal');
      expect({ status: journal?.status, error: journal?.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const seen = new Set<string>();
      for (const denied of [false, true, false]) {
        const modelCalls = llm.requests.length;
        await harness.run('summary', failure, {
          apiKey: denied ? deniedKey : harness.apiKey,
          userName: denied ? 'other-summary-reader' : 'elastic',
        });
        const execution = (await harness.executionsOf('summary')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No summary execution was persisted');
        seen.add(execution.id);
        if (denied) {
          expect(execution.status).toBe('failed');
          expect(llm.requests).toHaveLength(modelCalls);
          continue;
        }
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const steps = await harness.stepsOf(execution.id);
        expect(steps.find(({ stepId }) => stepId === 'summarize')).toMatchObject({
          status: 'completed',
          output: { skipped: false, summary: SUMMARY },
        });
        expect(steps.find(({ stepId }) => stepId === 'read')).toMatchObject({
          status: 'completed',
          output: { metadata: { summary: SUMMARY } },
        });
        expect(llm.requests.length).toBeGreaterThan(modelCalls);
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 4);
      expect(harness.kibanaRequests).toEqual([]);
      expect(defaultLlm.requests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
