/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer } from 'http';
import type { IncomingHttpHeaders, Server } from 'http';
import type { AddressInfo } from 'net';
import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const MODEL_WORKFLOW_ID = 'evals-model-workflow';
const AGENT_WORKFLOW_ID = 'evals-agent-workflow';
const SUITE_WORKFLOW_ID = 'evals-suite-workflow';
const CONNECTOR_ID = 'llm-connector';
const ANSWER = 'the model answer';

const executeTask = (name: string, task: Record<string, unknown>) => ({
  name,
  type: 'ai.evals.executeTask',
  with: {
    connector_id: CONNECTOR_ID,
    example: { id: 'example-1', input: { input: 'What is the capital of France?' } },
    ...task,
  },
});

/**
 * Runs `workflow:scheduled` workflows with `ai.evals.executeTask` from the real bundle in a real
 * task process: the steps come from the `workflow-steps` contribution of evals. The direct model
 * task calls an LLM (a stub) through the inference services built from the host, the agent task
 * calls Kibana's converse API through the self client, and a task a suite registered is declined.
 */
describe('evals workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  let llmStub: Server;
  const llmRequests: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    llmStub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        llmRequests.push({ url: req.url, headers: req.headers, body });
        const base = { id: 'chatcmpl-1', created: 1, model: 'gpt-4' };
        const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
        let streaming = false;
        try {
          streaming = JSON.parse(body).stream === true;
        } catch (e) {
          // not JSON: answer as a plain completion
        }
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [
                { index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: null },
              ],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage,
            })}\n\n`
          );
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...base,
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: ANSWER },
                  finish_reason: 'stop',
                },
              ],
              usage,
            })
          );
        }
      });
    });
    await new Promise<void>((resolve) => llmStub.listen(0, '127.0.0.1', resolve));
    const llmUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

    harness = await startWorkflowProcessHarness({
      workflows: {
        [MODEL_WORKFLOW_ID]: { steps: [executeTask('model', {})] },
        [AGENT_WORKFLOW_ID]: { steps: [executeTask('agent', { agent_id: 'my-agent' })] },
        [SUITE_WORKFLOW_ID]: { steps: [executeTask('suite', { task_ref: 'suite.custom_task' })] },
      },
      kibanaHandler: () => ({
        body: {
          conversation_id: 'conversation-1',
          trace_id: '0af7651916cd43dd8448eb211c80319c',
          response: { message: 'the agent answer' },
        },
      }),
      seed: async ({ host }) => {
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

  const completedStep = async (workflowId: string, stepId: string) => {
    const [execution] = await harness.executionsOf(workflowId);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const steps = await harness.stepsOf(execution.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(expect.objectContaining({ stepId, status: 'completed' }));
    return steps[0];
  };

  it('runs the direct model task through the inference services of the process', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(MODEL_WORKFLOW_ID, onDispatchFailure);
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const step = await completedStep(MODEL_WORKFLOW_ID, 'model');
    expect(step.output.output).toEqual(expect.objectContaining({ content: ANSWER }));
    expect(llmRequests.length).toBeGreaterThan(0);
    expect(llmRequests[0].headers.authorization).toBe('Bearer test-key');
    expect(llmRequests[0].body).toContain('What is the capital of France?');
  });

  it('runs the agent task through the Kibana API with the credential of the run', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(AGENT_WORKFLOW_ID, onDispatchFailure);
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const step = await completedStep(AGENT_WORKFLOW_ID, 'agent');
    expect(step.output.output).toEqual(
      expect.objectContaining({ message: 'the agent answer', conversation_id: 'conversation-1' })
    );
    const [request] = harness.kibanaRequests.filter(
      ({ url }) => url === '/api/agent_builder/converse'
    );
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe(`ApiKey ${harness.apiKey}`);
    expect(JSON.parse(request.body)).toEqual(
      expect.objectContaining({ agent_id: 'my-agent', connector_id: CONNECTOR_ID })
    );
  });

  it('declines a task a suite registered in Kibana, writing nothing', async () => {
    const onDispatchFailure = jest.fn();
    await expect(harness.run(SUITE_WORKFLOW_ID, onDispatchFailure)).rejects.toThrow('422');

    expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(SUITE_WORKFLOW_ID)).toHaveLength(0);
  });
});
