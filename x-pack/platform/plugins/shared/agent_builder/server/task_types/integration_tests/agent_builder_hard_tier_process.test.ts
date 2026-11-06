/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { configSchema as agentBuilderConfigSchema } from '../../config';
import { collectRegisteredIds } from '../../run_services/collect_registered_ids';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '../../run_services/run_settings';
import { agentBuilderSpaceSettingsType } from '../../saved_objects';
import { getExampleContributionSettings } from '../example_contribution_settings';
import { call, FINAL_ANSWER, outputOf, startLlmStub, withSkill } from './llm_stub';

const { getContributionFiles } = require(join(REPO_ROOT, 'src/dev/task_bundles/build'));

const CONNECTOR_ID = 'llm-connector';
const STREAMS_WORKFLOW_ID = 'streams-agent-workflow';
const ILM_POLICY = 'agent-streams-policy';
const INSPECT_TOOL = 'platform.streams.inspect_streams';
const ILM_TOOL = 'platform.streams.list_ilm_policies';

/**
 * Runs workflows with an `ai.agent` step from the real `workflow:scheduled` bundle in a real task
 * process, against a real Elasticsearch and a stub LLM, for the tools of the plugins of the hard tier:
 * the streams tools read the cluster with the scoped clients of `createStreamsRunServices` (the streams
 * client over its storage, the scoped Elasticsearch client).
 */
describe('agent builder tools of the hard tier served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  let llm: Awaited<ReturnType<typeof startLlmStub>>;

  beforeAll(async () => {
    llm = await startLlmStub();

    const contributions: AgentBuilderContribution[] = getContributionFiles('agent-builder').map(
      (file: string) => require(file).contribution
    );
    const settings = {
      ...getExampleContributionSettings(contributions),
      [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
        config: agentBuilderConfigSchema.validate({}, { dev: false }),
        env: {
          packageInfo: { version: kibanaPackageJson.version, buildFlavor: 'traditional' },
          airgapped: false,
        } as never,
        getSearchInferenceEndpoints: () => undefined,
      }),
    };
    const registered = await collectRegisteredIds({
      contributions,
      settings,
      logger: loggingSystemMock.createLogger(),
    });
    expect(registered.tools).toEqual(expect.arrayContaining([INSPECT_TOOL, ILM_TOOL]));

    harness = await startWorkflowProcessHarness({
      workflows: {
        [STREAMS_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              with: {
                message: withSkill(
                  'streams-management',
                  `${call(ILM_TOOL, {})}\n${call(INSPECT_TOOL, { names: ['*'] })}`
                ),
              },
            },
          ],
        },
      },
      settings,
      seedContributions: { 'agent-builder': contributions },
      parity: Object.entries(registered).map(([kind, ids]) => ({
        kind: `agentBuilder.${kind}`,
        ids,
      })),
      savedObjectTypes: [
        agentBuilderSpaceSettingsType,
        {
          name: 'usage-counter',
          indexPattern: '.kibana_usage_counters',
          mappings: {
            dynamic: false,
            properties: {
              domainId: { type: 'keyword' },
              counterName: { type: 'keyword' },
              counterType: { type: 'keyword' },
              source: { type: 'keyword' },
              count: { type: 'integer' },
            },
          },
        },
      ] as never,
      seed: async ({ es, host }) => {
        await es.index({
          index: '.kibana',
          id: 'space:default',
          refresh: true,
          document: {
            type: 'space',
            space: { name: 'Default', disabledFeatures: [] },
            updated_at: new Date().toISOString(),
          },
        });
        await es.ilm.putLifecycle({
          name: ILM_POLICY,
          policy: { phases: { hot: { actions: { rollover: { max_age: '30d' } } } } },
        });
        await host.savedObjects
          .getUnsafeInternalClient()
          .create(
            'config',
            { 'agentBuilder:experimentalFeatures': true, buildNum: 1 },
            { id: kibanaPackageJson.version, overwrite: true }
          );
        await host.savedObjects.getUnsafeInternalClient({ includedHiddenTypes: ['action'] }).create(
          'action',
          {
            name: 'stub llm',
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

  it('lists the ILM policies and inspects the streams with the tools of streams, with the clients of the process', async () => {
    const fallback = jest.fn();
    const from = llm.requests.length;
    await harness.run(STREAMS_WORKFLOW_ID, fallback as never);

    // Not declined: the registries of the process are what Kibana's are.
    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(STREAMS_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const agent = (await harness.stepsOf(execution.id)).find((step) => step.stepId === 'agent')!;
    expect(outputOf(agent).message).toBe(FINAL_ANSWER);

    const results = llm.toolResultsSince(from);
    // The policy of the cluster, read with the scoped Elasticsearch client.
    expect(results).toContain(ILM_POLICY);
    // The streams client over its storage answered: there are no streams.
    expect(results).toContain('No streams found.');
  });
});
