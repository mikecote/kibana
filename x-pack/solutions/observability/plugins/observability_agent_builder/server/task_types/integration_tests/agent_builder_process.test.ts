/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from '@kbn/zod/v4';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { OBSERVABILITY_LOGS_DATA_ACCESS_LOG_SOURCES_ID } from '@kbn/management-settings-ids';
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
import { contribution as logsContribution } from '@kbn/logs-data-access-plugin/server/task_types/workflow_services_contribution';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import type { ObservabilityAgentBuilderTaskProcessSettings } from '../observability_agent_builder_task_process_settings';
import { OBSERVABILITY_GET_LOGS_TOOL_ID } from '../../tools/get_logs/constants';

const loadModule = createRequire(__filename);
const { getContributionFiles } = loadModule(join(REPO_ROOT, 'src/dev/task_bundles/build')) as {
  getContributionFiles: (key: string) => string[];
};
const CONNECTOR = 'observability-worker-model';
const FIRST_INDEX = 'observability-native-logs-first';
const SECOND_INDEX = 'observability-native-logs-second';
const resultSchema = z.object({
  results: z.array(
    z.object({
      type: z.string(),
      data: z
        .object({
          totalCount: z.number().optional(),
          samples: z
            .array(z.object({ message: z.string().optional(), _index: z.string().optional() }))
            .optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
  ),
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Observability tools in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    let deniedKey: string;
    const logs: string[] = [];
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
      const exampleSettings = getExampleContributionSettings(contributions);
      const settings = {
        ...exampleSettings,
        observabilityAgentBuilderRuntime: {
          ...(exampleSettings.observabilityAgentBuilderRuntime as ObservabilityAgentBuilderTaskProcessSettings),
          dataProviders: [],
          mlEnabled: false,
          spacesEnabled: true,
        },
        logsDataAccessRuntime: { enabled: true },
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
        seedContributions: { 'agent-builder': contributions, 'workflow-steps': [logsContribution] },
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        parity: Object.entries(ids).map(([kind, registered]) => ({
          kind: `agentBuilder.${kind}`,
          ids: registered,
        })),
        workflows: {
          logs: {
            steps: [
              {
                name: 'logs',
                type: 'ai.agent',
                'connector-id': CONNECTOR,
                with: {
                  configuration_overrides: {
                    enable_elastic_capabilities: false,
                    tools: [{ tool_ids: [OBSERVABILITY_GET_LOGS_TOOL_ID] }],
                  },
                  message: call(OBSERVABILITY_GET_LOGS_TOOL_ID, {
                    start: 'now-1h',
                    end: 'now',
                    fields: ['message'],
                    limit: 10,
                  }),
                },
              },
            ],
          },
        },
        seed: async ({ host, es }) => {
          for (const [index, count] of [
            [FIRST_INDEX, 1],
            [SECOND_INDEX, 2],
          ] as const) {
            await es.indices.create({
              index,
              mappings: {
                properties: {
                  '@timestamp': { type: 'date' },
                  message: { type: 'text' },
                  'service.name': { type: 'keyword' },
                  'log.level': { type: 'keyword' },
                },
              },
            });
            for (let document = 0; document < count; document++)
              await es.index({
                index,
                id: `log-${document}`,
                refresh: 'wait_for',
                document: {
                  '@timestamp': new Date().toISOString(),
                  message: `Native worker message ${document}`,
                  service: { name: 'checkout' },
                  log: { level: 'error' },
                },
              });
          }
          const client = host.savedObjects.getUnsafeInternalClient();
          await client.create(
            'config',
            {
              'agentBuilder:experimentalFeatures': true,
              [OBSERVABILITY_LOGS_DATA_ACCESS_LOG_SOURCES_ID]: [FIRST_INDEX],
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
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Observability proof requires native Security');
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                observability_without_logs: {
                  application: 'kibana-.kibana',
                  name: 'observability_without_logs',
                  actions: [
                    security.authz.actions.login,
                    security.authz.actions.savedObject.get('*', '*'),
                    security.authz.actions.api.get('*'),
                  ],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'observability-without-logs',
            role_descriptors: {
              native: {
                cluster: [],
                indices: [{ names: ['.*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['observability_without_logs'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          deniedKey = key.encoded;
        },
      });
    }, 300000);
    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
    });
    it('executes the native log tool with current credentials and current log sources without calling Kibana', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      const results: Array<z.infer<typeof resultSchema>['results'][number]> = [];
      for (const apiKey of [harness.apiKey, deniedKey, harness.apiKey]) {
        if (results.length === 2)
          await harness.es.update({
            index: '.kibana',
            id: `config:${kibanaPackageJson.version}`,
            refresh: 'wait_for',
            doc: { config: { [OBSERVABILITY_LOGS_DATA_ACCESS_LOG_SOURCES_ID]: [SECOND_INDEX] } },
          });
        const offset = llm.requests.length;
        await harness.run('logs', failure, { apiKey });
        const execution = (await harness.executionsOf('logs')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No Observability execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error, logs }).toEqual({
          status: 'completed',
          error: undefined,
          logs: expect.any(Array),
        });
        const messages = llm.toolResultsSince(offset).split('\n').filter(Boolean);
        for (const line of messages) {
          const { response } = z.object({ response: z.string() }).parse(JSON.parse(line));
          results.push(
            ...resultSchema.parse(
              JSON.parse(response.replace(/^<tool_result>|<\/tool_result>$/g, '').trim())
            ).results
          );
        }
      }
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({
        type: 'other',
        data: {
          totalCount: 1,
          samples: [{ _index: FIRST_INDEX, message: 'Native worker message 0' }],
        },
      });
      expect(results[1]).toMatchObject({
        type: 'error',
        data: { message: expect.stringContaining('security_exception') },
      });
      expect(results[2]).toMatchObject({ type: 'other', data: { totalCount: 2 } });
      expect(results[2].data?.samples).toEqual(
        expect.arrayContaining([expect.objectContaining({ _index: SECOND_INDEX })])
      );
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
