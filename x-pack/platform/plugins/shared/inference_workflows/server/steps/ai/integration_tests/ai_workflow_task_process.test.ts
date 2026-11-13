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

const WORKFLOW_ID = 'ai-prompt-workflow';
const FEATURE_WORKFLOW_ID = 'ai-feature-workflow';
const CONNECTOR_ID = 'llm-connector';
const ANSWER = 'hello from the stub model';

/**
 * Runs a `workflow:scheduled` workflow with the `ai.prompt` step from the real bundle in a real task
 * process: the step comes from the `workflow-steps` contribution of inference_workflows, resolves the
 * connector Kibana saved with the actions client of the run, and calls the LLM (a stub server) through
 * the inference services built from the host. The run is served by the process (not declined).
 */
describe('inference_workflows steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  let llmStub: Server;
  const llmRequests: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    // An OpenAI-compatible LLM: answers a chat completion, streamed or not as asked.
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
      settings: {
        inferenceFeatures: {
          features: [
            {
              featureId: 'other_plugin',
              featureName: 'Another plugin',
              featureDescription: 'A parent registered by another plugin',
              taskType: 'chat_completion',
              recommendedEndpoints: [],
            },
            {
              featureId: 'other_plugin_prompt',
              parentFeatureId: 'other_plugin',
              featureName: 'Prompt',
              featureDescription: 'Uses the endpoint selected in Kibana',
              taskType: 'chat_completion',
              recommendedEndpoints: [CONNECTOR_ID],
              ignoreGlobalDefault: true,
            },
          ],
        },
      },
      workflows: {
        // Neither feature is registered by inference_workflows: both come from the dispatch snapshot.
        [FEATURE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'ask',
              type: 'ai.prompt',
              'connector-id-by-feature': "{{ 'other_plugin_prompt' }}",
              with: { prompt: 'Say hello to the workflow' },
            },
          ],
        },
        [WORKFLOW_ID]: {
          steps: [
            {
              name: 'ask',
              type: 'ai.prompt',
              'connector-id': CONNECTOR_ID,
              with: { prompt: 'Say hello to the workflow' },
            },
          ],
        },
      },
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

  it('runs ai.prompt in the process: the connector of Kibana, the LLM called with its credentials', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step type is in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const steps = await harness.stepsOf(execution.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(expect.objectContaining({ stepId: 'ask', status: 'completed' }));
    expect(steps[0].output).toEqual(expect.objectContaining({ content: ANSWER }));

    // The LLM got the prompt, with the credential of the connector.
    expect(llmRequests.length).toBeGreaterThan(0);
    expect(llmRequests[0].url).toBe('/v1/chat/completions');
    expect(llmRequests[0].headers.authorization).toBe('Bearer test-key');
    expect(llmRequests[0].body).toContain('Say hello to the workflow');
  });

  it('resolves a templated feature registered by another plugin using Kibana endpoint recommendations', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(FEATURE_WORKFLOW_ID, onDispatchFailure);

    expect(onDispatchFailure).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(FEATURE_WORKFLOW_ID);
    expect(execution.status).toBe('completed');
    const steps = await harness.stepsOf(execution.id);
    expect(steps[0].output).toEqual(expect.objectContaining({ content: ANSWER }));
  });
});
