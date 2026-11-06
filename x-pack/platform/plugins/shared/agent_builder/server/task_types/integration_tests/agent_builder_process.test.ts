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
import { collectRegisteredIds } from '../../run_services/collect_registered_ids';
import { getAgentBuilderRunSettings } from '../../run_services/run_settings';
import { AGENT_BUILDER_RUN_SETTINGS_ID } from '../../run_services/run_settings';
import { getExampleContributionSettings } from '../example_contribution_settings';
import { agentBuilderSpaceSettingsType } from '../../saved_objects';
import { configSchema as agentBuilderConfigSchema } from '../../config';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const { getContributionFiles } = require(join(REPO_ROOT, 'src/dev/task_bundles/build'));

const CONNECTOR_ID = 'llm-connector';
const AGENT_WORKFLOW_ID = 'agent-workflow';
const CONVERSATION_WORKFLOW_ID = 'conversation-workflow';
const INDEX = 'agent-docs-index';
const FINAL_ANSWER = 'There is one index with documents.';

const outputOf = (step: any) => step.output.output ?? step.output;

interface ChatRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: unknown;
  stream?: boolean;
}

/**
 * Runs a workflow with an `ai.agent` step from the real `workflow:scheduled` bundle in a real task
 * process, against a real Elasticsearch and a stub of the LLM (an OpenAI compatible endpoint behind a
 * `.gen-ai` connector). The registries of agent builder are filled by the `agent-builder`
 * contributions of the plugins (the ones `kibana.jsonc` lists), the agent calls a platform tool that
 * lists the indices of the cluster, and the conversation is stored.
 */
describe('ai.agent served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  let llmStub: Server;
  const llmRequests: ChatRequest[] = [];

  const toolCallChunk = (name: string, args: Record<string, unknown>) => ({
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });

  /** What the model answers: a title for the conversation, the tool call, and then the answer. */
  const answerTo = (request: ChatRequest) => {
    const system = String(request.messages.find(({ role }) => role === 'system')?.content ?? '');
    const toolChoice = (request.tool_choice as { function?: { name?: string } } | undefined)
      ?.function?.name;
    if (toolChoice === 'set_title' || system.includes('You are a title-generation utility')) {
      return toolCallChunk('set_title', { title: 'Indices of the cluster' });
    }
    const listIndices = request.tools?.find(({ function: { name } }) =>
      name.includes('list_indices')
    )?.function.name;
    const hasToolResult = request.messages.some(({ role }) => role === 'tool');
    if (listIndices && !hasToolResult) {
      return toolCallChunk(listIndices, { pattern: `${INDEX}*` });
    }
    return {
      choices: [
        { index: 0, delta: { role: 'assistant', content: FINAL_ANSWER }, finish_reason: null },
      ],
    };
  };

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

    // What Kibana sends: the settings of agent builder and of every plugin that registers with it,
    // and the ids it registered, which here are what all the contributions register.
    const contributions: AgentBuilderContribution[] = getContributionFiles('agent-builder').map(
      (file: string) => require(file).contribution
    );
    const contributionSettings = getExampleContributionSettings(contributions);
    const settings = {
      ...contributionSettings,
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
    expect(registered.tools).toContain('platform.core.list_indices');

    harness = await startWorkflowProcessHarness({
      workflows: {
        [AGENT_WORKFLOW_ID]: {
          steps: [
            {
              name: 'agent',
              type: 'ai.agent',
              'connector-id': CONNECTOR_ID,
              'create-conversation': true,
              with: { message: `Which indices match ${INDEX}*?` },
            },
          ],
        },
        [CONVERSATION_WORKFLOW_ID]: {
          steps: [
            {
              name: 'create',
              type: 'ai.conversation.create',
              with: { agent_id: 'elastic-ai-agent', title: 'From a workflow' },
            },
          ],
        },
      },
      settings,
      parity: Object.entries(registered).map(([kind, ids]) => ({
        kind: `agentBuilder.${kind}`,
        ids,
      })),
      savedObjectTypes: [agentBuilderSpaceSettingsType],
      seed: async ({ es, host }) => {
        await es.index({ index: INDEX, id: '1', document: { text: 'hello' }, refresh: true });
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

  it('runs the agent in the process with a platform tool that reads Elasticsearch', async () => {
    const fallback = jest.fn();
    await harness.run(AGENT_WORKFLOW_ID, fallback as never);

    // Not declined: the registries of the process are what Kibana's are.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(AGENT_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const steps = await harness.stepsOf(execution.id);
    const agent = steps.find((step) => step.stepId === 'agent')!;
    expect(agent.status).toBe('completed');
    expect(outputOf(agent).message).toBe(FINAL_ANSWER);
    expect(outputOf(agent).conversation_id).toEqual(expect.any(String));

    // The model was called with the tools of the registries, and was sent the tool's own result.
    const toolNames = llmRequests.flatMap((request) =>
      (request.tools ?? []).map(({ function: { name } }) => name)
    );
    expect(toolNames.some((name) => name.includes('list_indices'))).toBe(true);
    const resultRequest = llmRequests.find((request) =>
      request.messages.some(({ role }) => role === 'tool')
    )!;
    expect(JSON.stringify(resultRequest.messages)).toContain(INDEX);
    expect(llmRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('stores the conversation with the tool call and its result', async () => {
    const [execution] = await harness.executionsOf(AGENT_WORKFLOW_ID);
    const steps = await harness.stepsOf(execution.id);
    const conversationId = outputOf(steps.find((step) => step.stepId === 'agent')).conversation_id;

    await harness.es.indices.refresh({ index: '.chat-conversations' });
    const { hits } = await harness.es.search<any>({
      index: '.chat-conversations',
      query: { term: { _id: conversationId } },
    });
    expect(hits.hits).toHaveLength(1);
    const stored = JSON.stringify(hits.hits[0]._source);
    expect(stored).toContain(FINAL_ANSWER);
    expect(stored).toContain('platform.core.list_indices');
    expect(stored).toContain(INDEX);
  });

  it('runs a conversation step, which reads the agents registry, in the process', async () => {
    const fallback = jest.fn();
    await harness.run(CONVERSATION_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(CONVERSATION_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
  });
});
