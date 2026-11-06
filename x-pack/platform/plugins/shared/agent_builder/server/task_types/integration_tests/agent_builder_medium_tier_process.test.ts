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

import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
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

const { getContributionFiles } = require(join(REPO_ROOT, 'src/dev/task_bundles/build'));

// What the plugins that contribute declare and store, loaded by path: the plugins depend on agent
// builder, which must not depend on them back.
const pluginFile = (path: string) =>
  require(join(REPO_ROOT, 'x-pack/platform/plugins/shared', path));
const { getCasesTaskProcessSavedObjectTypes } = pluginFile(
  'cases/server/task_types/cases_saved_object_types'
);
const { getMlTaskProcessSavedObjectTypes } = pluginFile(
  'ml/server/task_types/ml_task_process_services'
);
const { createProposalsStorageClient } = pluginFile('proposals/server/storage/proposals_storage');

const CONNECTOR_ID = 'llm-connector';
const CASES_WORKFLOW_ID = 'cases-agent-workflow';
const CONTEXT_ENGINE_WORKFLOW_ID = 'context-engine-agent-workflow';
const AI_INDEX_ID = 'support-tickets';
const KI_INDEX = 'ai-index-idx-support-tickets';
const ML_WORKFLOW_ID = 'ml-agent-workflow';
const ML_JOB_ID = 'agent-job';
const PROPOSALS_WORKFLOW_ID = 'proposals-agent-workflow';
const PROPOSAL_ID = 'proposal-1';
const CASES_INDEX = '.kibana_alerting_cases';
const FINAL_ANSWER = 'Done.';
const CASE_TITLE = 'Opened by an agent in a task process';

const CASES_TOOL = 'platform.core.cases.manage';
const LIST_AI_INDICES_TOOL = 'platform.context_engine.list_ai_indices';
const ML_UPDATE_JOB_TOOL = 'ml.ad_update_job_config';
const REVISE_PROPOSAL_TOOL = 'platform.proposals.revise';

const outputOf = (step: any) => step.output.output ?? step.output;
// The names the model sees: ids with the characters it does not take replaced.
const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

interface ChatRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: unknown;
  stream?: boolean;
}

/**
 * Runs workflows with an `ai.agent` step from the real `workflow:scheduled` bundle in a real task
 * process, against a real Elasticsearch and a stub LLM, for tools of the plugins that contribute their
 * registrations to agent builder's registries with services of their own: the cases tool creates a case
 * (the cases client of the process, over the saved objects of the cluster), and the context engine tool
 * reads the AI indices of the space (the context engine services over the internal client, the
 * `contextEngine:enabled` space setting and the user's privilege). The model is told which tool to call
 * by the message of the step (`CALL <tool id> <json arguments>`), and the run is not declined.
 */
describe('agent builder tools of the medium tier served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  let llmStub: Server;
  const llmRequests: ChatRequest[] = [];

  const toolCallChunk = (name: string, args: Record<string, unknown>, id = 'call_1') => ({
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });

  const answerTo = (request: ChatRequest) => {
    const system = String(request.messages.find(({ role }) => role === 'system')?.content ?? '');
    const toolChoice = (request.tool_choice as { function?: { name?: string } } | undefined)
      ?.function?.name;
    if (toolChoice === 'set_title' || system.includes('You are a title-generation utility')) {
      return toolCallChunk('set_title', { title: 'A tool call' });
    }
    const lastUser = [...request.messages].reverse().find(({ role }) => role === 'user')?.content;
    const text = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser);
    // The calls the message asks for, one per line, made in order: the number of results the model has
    // received is the number of calls made.
    const calls = [...String(text).matchAll(/CALL (\S+) (\{[^\n]*\})/g)].map(
      ([, toolId, json]) => ({ toolId, args: JSON.parse(json) })
    );
    const made = request.messages.filter(({ role }) => role === 'tool').length;
    const next = calls[made];
    if (next) {
      const tool = request.tools?.find(({ function: { name } }) => name === modelName(next.toolId));
      // A tool the model is not offered cannot be called: it answers without it, and the test fails.
      if (tool) return toolCallChunk(tool.function.name, next.args, `call_${made + 1}`);
    }
    return {
      choices: [
        { index: 0, delta: { role: 'assistant', content: FINAL_ANSWER }, finish_reason: null },
      ],
    };
  };

  /** What the tool answered the model, from the requests the stub received since `from`. */
  const toolResultsSince = (from: number) =>
    llmRequests
      .slice(from)
      .flatMap(({ messages }) => messages.filter(({ role }) => role === 'tool'))
      .map(({ content }) => (typeof content === 'string' ? content : JSON.stringify(content)))
      .join('\n');

  const call = (toolId: string, args: Record<string, unknown>) =>
    `CALL ${toolId} ${JSON.stringify(args)}`;
  /** Loads the skill that gives the agent the tool, as an agent does, and then calls the tool. */
  const withSkill = (skill: string, toolCall: string) =>
    `${call('load_skill', { skill })}\n${toolCall}`;

  beforeAll(async () => {
    llmStub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const request = JSON.parse(body || '{}') as ChatRequest;
        llmRequests.push(request);
        const base = { id: 'chatcmpl-1', created: 1, model: 'gpt-4' };
        const chunk = answerTo(request);
        const finish =
          (chunk.choices[0].delta as { content?: string }).content === FINAL_ANSWER
            ? 'stop'
            : 'tool_calls';
        const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
        if (request.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...chunk })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
              usage,
            })}\n\n`
          );
          res.end('data: [DONE]\n\n');
        } else {
          const { delta } = chunk.choices[0];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...base,
              object: 'chat.completion',
              choices: [{ index: 0, message: delta, finish_reason: finish }],
              usage,
            })
          );
        }
      });
    });
    await new Promise<void>((resolve) => llmStub.listen(0, '127.0.0.1', resolve));
    const llmUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

    // What Kibana sends: the settings of agent builder and of every plugin that registers with it, and
    // the ids it registered, which here are what all the contributions register.
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
    expect(registered.tools).toEqual(expect.arrayContaining([CASES_TOOL, LIST_AI_INDICES_TOOL]));

    harness = await startWorkflowProcessHarness({
      workflows: {
        [CASES_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              with: {
                message: withSkill(
                  'cases-management',
                  call(CASES_TOOL, {
                    mode: 'create',
                    title: CASE_TITLE,
                    description: 'Created by the cases tool of agent builder',
                    owner: 'securitySolution',
                    tags: ['from-agent'],
                  })
                ),
              },
            },
          ],
        },
        [ML_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              with: {
                message: withSkill(
                  'anomaly-detection',
                  call(ML_UPDATE_JOB_TOOL, {
                    operation: 'update_memory_limit',
                    job_id: ML_JOB_ID,
                    memory_limit: '512mb',
                  })
                ),
              },
            },
          ],
        },
        [PROPOSALS_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              with: {
                message: withSkill(
                  'proposal-management',
                  call(REVISE_PROPOSAL_TOOL, {
                    proposalId: PROPOSAL_ID,
                    title: 'Isolate the host now',
                    comment: 'Isolate the host now, it is spreading',
                  })
                ),
              },
            },
          ],
        },
        [CONTEXT_ENGINE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              with: { message: withSkill('analyze-and-improve', call(LIST_AI_INDICES_TOOL, {})) },
            },
          ],
        },
      },
      settings,
      parity: Object.entries(registered).map(([kind, ids]) => ({
        kind: `agentBuilder.${kind}`,
        ids,
      })),
      savedObjectTypes: [
        agentBuilderSpaceSettingsType,
        ...getCasesTaskProcessSavedObjectTypes(),
        ...getMlTaskProcessSavedObjectTypes(),
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
        // The default space Kibana has.
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
        // The AI index Kibana would have stored, over a plain index (see the context engine's process
        // test for why a template of a higher priority is needed).
        await es.indices.putIndexTemplate({
          name: 'plain-ki-index',
          index_patterns: [KI_INDEX],
          priority: 100000,
          template: { settings: { number_of_replicas: 0 } },
        });
        await es.indices.create({
          index: KI_INDEX,
          mappings: { properties: { '@timestamp': { type: 'date' } } },
        });
        await new AiIndexService({
          esClient: es as never,
          logger: loggingSystemMock.createLogger(),
        }).put(AI_INDEX_ID, 'default', {
          dest: { type: 'index', value: KI_INDEX },
          description: 'Support tickets of the team.',
          automations: [],
          sources: [],
          traces: [],
        });
        // An anomaly detection job, with the saved object that makes it visible in the default space.
        await es.ml.putJob({
          job_id: ML_JOB_ID,
          analysis_config: { bucket_span: '15m', detectors: [{ function: 'count' }] },
          data_description: { time_field: '@timestamp' },
        });
        await es.index({
          index: '.kibana',
          id: `ml-job:anomaly-detector-${ML_JOB_ID}`,
          refresh: true,
          document: {
            type: 'ml-job',
            'ml-job': {
              job_id: ML_JOB_ID,
              datafeed_id: `datafeed-${ML_JOB_ID}`,
              type: 'anomaly-detector',
            },
            namespaces: ['default'],
            references: [],
            updated_at: new Date().toISOString(),
          },
        });
        // The proposal Kibana would have stored.
        const now = new Date().toISOString();
        await createProposalsStorageClient({
          esClient: es as never,
          logger: loggingSystemMock.createLogger(),
        }).index({
          id: PROPOSAL_ID,
          refresh: true,
          document: {
            spaceId: 'default',
            conversationId: 'conversation-1',
            title: 'Isolate the host',
            comment: 'Isolate the host',
            status: 'pending',
            rootProposalId: PROPOSAL_ID,
            revision: 1,
            impact: 'high',
            confidence: 'medium',
            category: 'containment',
            origin: 'agent_builder',
            createdAt: now,
            createdBy: { username: 'elastic', fullName: null, email: null },
            ranks: { impact: 1, confidence: 1 },
          },
        } as never);
        // The space setting that turns the context engine on.
        await host.savedObjects
          .getUnsafeInternalClient()
          .create(
            'config',
            { 'contextEngine:enabled': true, buildNum: 1 },
            { id: kibanaPackageJson.version, overwrite: true }
          );
        // The connector Kibana would have saved: an LLM connector (the client encrypts its secrets).
        await host.savedObjects.getUnsafeInternalClient({ includedHiddenTypes: ['action'] }).create(
          'action',
          {
            name: 'stub llm',
            actionTypeId: '.gen-ai',
            isMissingSecrets: false,
            config: {
              apiProvider: 'OpenAI',
              apiUrl: `${llmUrl}/v1/chat/completions`,
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
    await new Promise((resolve) => llmStub?.close(resolve));
  });

  it('creates a case with the cases tool, with the cases client of the process', async () => {
    const fallback = jest.fn();
    const from = llmRequests.length;
    await harness.run(CASES_WORKFLOW_ID, fallback as never);

    // Not declined: the registries of the process are what Kibana's are.
    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(CASES_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const agent = (await harness.stepsOf(execution.id)).find((step) => step.stepId === 'agent')!;
    expect(agent.status).toBe('completed');
    expect(outputOf(agent).message).toBe(FINAL_ANSWER);

    // The tool answered the model with the case it created.
    expect(toolResultsSince(from)).toContain(CASE_TITLE);

    // The case the tool created is stored, with the user the run is for.
    await harness.es.indices.refresh({ index: CASES_INDEX });
    const { hits } = await harness.es.search<any>({
      index: CASES_INDEX,
      query: { term: { type: 'cases' } },
    });
    const titles = hits.hits.map((hit) => hit._source.cases.title);
    expect(titles).toContain(CASE_TITLE);
    const stored = hits.hits.find((hit) => hit._source.cases.title === CASE_TITLE)!._source.cases;
    expect(stored.tags).toEqual(['from-agent']);
    expect(stored.owner).toBe('securitySolution');
  });

  it('lists the AI indices of the space with the context engine tool', async () => {
    const fallback = jest.fn();
    const from = llmRequests.length;
    await harness.run(CONTEXT_ENGINE_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(CONTEXT_ENGINE_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const agent = (await harness.stepsOf(execution.id)).find((step) => step.stepId === 'agent')!;
    expect(outputOf(agent).message).toBe(FINAL_ANSWER);

    // The model was sent the tool's result: the AI index of the space, read from storage.
    const result = toolResultsSince(from);
    expect(result).toContain(AI_INDEX_ID);
    expect(result).toContain(KI_INDEX);
  });

  it('revises a proposal with the proposals tool, with the service of the process', async () => {
    const fallback = jest.fn();
    const from = llmRequests.length;
    await harness.run(PROPOSALS_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(PROPOSALS_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));

    // The successor revision was written, and the first is superseded.
    expect(toolResultsSince(from)).toContain('"revision\\":2');
    await harness.es.indices.refresh({ index: '.kibana-proposals*' });
    const { hits } = await harness.es.search<any>({
      index: '.kibana-proposals*',
      query: { term: { rootProposalId: PROPOSAL_ID } },
      sort: [{ revision: 'asc' }],
    });
    expect(hits.hits.map((hit) => [hit._source.revision, hit._source.status])).toEqual([
      [1, 'superseded'],
      [2, 'pending'],
    ]);
    expect(hits.hits[1]._source.title).toBe('Isolate the host now');
  });

  it('updates an anomaly detection job with the ML skill, with the ML client of the process', async () => {
    const fallback = jest.fn();
    const from = llmRequests.length;
    await harness.run(ML_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(ML_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    // The tool answered the model, and the job was updated in the cluster.
    expect(toolResultsSince(from)).toContain(ML_JOB_ID);
    const { jobs } = await harness.es.ml.getJobs({ job_id: ML_JOB_ID });
    expect(jobs[0].analysis_limits?.model_memory_limit).toBe('512mb');
  });
});
