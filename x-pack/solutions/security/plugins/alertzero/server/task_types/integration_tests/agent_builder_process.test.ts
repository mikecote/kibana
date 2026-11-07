/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z, lazySchema } from '@kbn/zod/v4';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import {
  ALERTZERO_ACTIONS_LIST_TOOL_ID,
  ALERTZERO_ENABLED_SETTING_ID,
} from '@kbn/alertzero-common';
import { configSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { getExampleContributionSettings } from '@kbn/agent-builder-plugin/server/task_types/example_contribution_settings';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import {
  call,
  startLlmStub,
} from '@kbn/agent-builder-plugin/server/task_types/integration_tests/llm_stub';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { ALERTZERO_AGENT_BUILDER_SETTINGS_ID } from '../alertzero_agent_builder_task_process_settings';
import { ALERTZERO_API_PRIVILEGE_READ } from '../../../common/constants';
import { extendWorkflowTestMappings } from './fixtures/workflow_test_mappings';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONNECTOR = 'alertzero-worker-model';
const resultSchema = lazySchema(() =>
  z.object({
    results: z.array(
      z.object({
        type: z.string(),
        data: z.object({
          total: z.number().optional(),
          actions: z.array(z.object({ workflowId: z.string(), name: z.string() })).optional(),
          message: z.string().optional(),
        }),
      })
    ),
  })
);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native AlertZero tools in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    let deniedKey: string;
    let readerKey: string;
    beforeAll(async () => {
      llm = await startLlmStub();
      const logger = loggingSystemMock.createLogger();
      const contributions = getContributionFiles('agent-builder').map(
        (file) => (loadModule(file) as { contribution: AgentBuilderContribution }).contribution
      );
      const settings = {
        ...getExampleContributionSettings(contributions),
        [ALERTZERO_AGENT_BUILDER_SETTINGS_ID]: {
          actionsAvailable: true,
          managementAvailable: true,
        },
        alertzero: {
          serviceAccountsEnabled: true,
          managedWorkflowsReady: true,
          searchInferenceEndpointsAvailable: false,
          actionsServiceAvailable: true,
          huntServicesReady: true,
          fleetAgentServiceAvailable: false,
          telemetryOptedIn: false,
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
        seedContributions: { 'agent-builder': contributions },
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          catalog: {
            steps: [
              {
                name: 'catalog',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                with: {
                  configuration_overrides: {
                    enable_elastic_capabilities: false,
                    tools: [{ tool_ids: [ALERTZERO_ACTIONS_LIST_TOOL_ID] }],
                  },
                  message: call(ALERTZERO_ACTIONS_LIST_TOOL_ID, { categories: ['contain'] }),
                },
              },
            ],
          },
          ...Object.fromEntries(
            ['native-action', 'other-category', 'other-space', 'private-action'].map((id) => [
              id,
              { steps: [{ name: 'action', type: 'console', with: { message: 'Native action' } }] },
            ])
          ),
        },
        seed: async ({ host, es }) => {
          await extendWorkflowTestMappings(es);
          const client = host.savedObjects.getUnsafeInternalClient();
          await client.create(
            'config',
            {
              'agentBuilder:experimentalFeatures': true,
              [ALERTZERO_ENABLED_SETTING_ID]: true,
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
              { id: CONNECTOR }
            );
          for (const [id, category, spaceId] of [
            ['native-action', 'contain', GLOBAL_WORKFLOW_SPACE_ID],
            ['other-category', 'escalate', GLOBAL_WORKFLOW_SPACE_ID],
            ['other-space', 'contain', 'unrelated-space'],
            ['private-action', 'contain', GLOBAL_WORKFLOW_SPACE_ID],
          ]) {
            await es.update({
              index: WORKFLOW_INDEX_NAME,
              id,
              refresh: 'wait_for',
              doc: {
                managed: true,
                managedBy: 'alertzero',
                spaceId,
                tags: ['action'],
                ...(id === 'private-action'
                  ? {
                      owner_id: 'another-profile',
                      access_control: { access_mode: 'private', entries: [] },
                    }
                  : {}),
                definition: {
                  consts: {
                    actionMetadata: { name: id, category, approvalPolicy: 'always-gate' },
                  },
                },
              },
            });
          }
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('AlertZero proof requires native Security');
          const savedObjectActions = [
            security.authz.actions.login,
            security.authz.actions.savedObject.get('*', '*'),
          ];
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                alertzero_without_read: {
                  application: 'kibana-.kibana',
                  name: 'alertzero_without_read',
                  actions: savedObjectActions,
                },
                alertzero_reader: {
                  application: 'kibana-.kibana',
                  name: 'alertzero_reader',
                  actions: [
                    ...savedObjectActions,
                    security.authz.actions.api.get(ALERTZERO_API_PRIVILEGE_READ),
                  ],
                },
              },
            },
          });
          const createKey = async (privilege: string): Promise<string> => {
            const key = await es.security.createApiKey({
              name: privilege,
              role_descriptors: {
                native: {
                  cluster: [],
                  indices: [{ names: ['.*'], privileges: ['all'], allow_restricted_indices: true }],
                  applications: [
                    {
                      application: 'kibana-.kibana',
                      privileges: [privilege],
                      resources: ['*'],
                    },
                  ],
                },
              },
            });
            return key.encoded;
          };
          deniedKey = await createKey('alertzero_without_read');
          readerKey = await createKey('alertzero_reader');
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });

    it('reads the managed action catalog with current privileges, workflow ACLs and space settings without calling Kibana', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      const results: Array<z.infer<typeof resultSchema>['results'][number]> = [];
      for (const [index, apiKey] of [
        readerKey,
        deniedKey,
        readerKey,
        readerKey,
        harness.apiKey,
        readerKey,
      ].entries()) {
        if (index >= 2)
          await harness.es.update({
            index: '.kibana',
            id: `config:${kibanaPackageJson.version}`,
            refresh: 'wait_for',
            doc: { config: { [ALERTZERO_ENABLED_SETTING_ID]: index > 2 } },
          });
        if (index === 2)
          await harness.es.update({
            index: WORKFLOW_INDEX_NAME,
            id: 'native-action',
            refresh: 'wait_for',
            doc: { definition: { consts: { actionMetadata: { name: 'Updated native action' } } } },
          });
        const offset = llm.requests.length;
        await harness.run('catalog', failure, { apiKey });
        const execution = (await harness.executionsOf('catalog')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No AlertZero execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        for (const line of llm.toolResultsSince(offset).split('\n').filter(Boolean)) {
          const { response } = z.object({ response: z.string() }).parse(JSON.parse(line));
          results.push(
            ...resultSchema.parse(
              JSON.parse(response.replace(/^<tool_result>|<\/tool_result>$/g, '').trim())
            ).results
          );
        }
      }
      expect(results).toHaveLength(6);
      expect(results[0]).toMatchObject({
        type: 'other',
        data: { total: 1, actions: [{ workflowId: 'native-action', name: 'native-action' }] },
      });
      expect(results[1]).toMatchObject({
        type: 'error',
        data: { message: expect.stringContaining('Missing AlertZero Read privilege') },
      });
      expect(results[2]).toMatchObject({
        type: 'error',
        data: { message: expect.stringContaining('AlertZero is disabled in this space') },
      });
      expect(results[3]).toMatchObject({
        type: 'other',
        data: {
          total: 1,
          actions: [{ workflowId: 'native-action', name: 'Updated native action' }],
        },
      });
      expect(results[4]).toMatchObject({
        type: 'other',
        data: {
          total: 2,
          actions: expect.arrayContaining([
            { workflowId: 'native-action', name: 'Updated native action' },
            { workflowId: 'private-action', name: 'private-action' },
          ]),
        },
      });
      expect(results[5]).toMatchObject({
        type: 'other',
        data: {
          total: 1,
          actions: [{ workflowId: 'native-action', name: 'Updated native action' }],
        },
      });
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 6);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    });
  }
);
