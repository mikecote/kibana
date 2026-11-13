/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest, tags } from '@kbn/scout';
import type { ApiClientFixture } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import {
  HEADERS,
  TEST_TIMEOUT_MS,
  getDispatchFailures,
  getStartedProcesses,
  uniqueName,
  waitFor,
} from '../fixtures';
import { startWorkflowLlmStub } from '../fixtures/workflow_llm_stub';

const EXECUTION_TIMEOUT_MS = 120_000;
const STEP_VISIBILITY_TIMEOUT_MS = 30_000;

interface Execution {
  id: string;
  status: string;
  error?: object;
  stepExecutions?: Array<{ id: string; stepId: string; status: string; output?: object }>;
}

const WORKFLOW_TAGS = [
  ...tags.stateful.classic,
  ...tags.serverless.search,
  ...tags.serverless.observability.complete,
  ...tags.serverless.security.complete,
].filter((tag) => tag.startsWith('@local-'));

apiTest.describe('Workflows in native task processes', { tag: WORKFLOW_TAGS }, () => {
  let client: ApiClientFixture;
  let headers: Record<string, string>;
  const spaceId = uniqueName('native-workflows');
  const prefix = `s/${spaceId}`;
  const workflowIds: string[] = [];
  const connectorIds: string[] = [];

  const createWorkflow = async (steps: string): Promise<string> => {
    const response = await client.post<{
      id: string;
      valid: boolean;
      validationErrors?: string[];
    }>(`${prefix}/api/workflows/workflow`, {
      headers,
      body: {
        yaml: `name: ${uniqueName(
          'native-workflow'
        )}\nenabled: true\ntriggers:\n  - type: manual\nsteps:\n${steps}`,
      },
    });
    expect(response).toHaveStatusCode(200);
    workflowIds.push(response.body.id);
    expect(response.body.validationErrors ?? []).toStrictEqual([]);
    expect(response.body.valid).toBe(true);
    return response.body.id;
  };
  const run = async (id: string): Promise<string> => {
    const response = await client.post<{ workflowExecutionId: string }>(
      `${prefix}/api/workflows/workflow/${id}/run`,
      { headers, body: { inputs: {} } }
    );
    expect(response).toHaveStatusCode(200);
    return response.body.workflowExecutionId;
  };
  const execution = async (id: string): Promise<Execution> => {
    const response = await client.get<Execution>(
      `${prefix}/api/workflows/executions/${id}?includeOutput=true`,
      { headers }
    );
    expect(response).toHaveStatusCode(200);
    return response.body;
  };
  const waitForStatus = async (id: string, status: string): Promise<Execution> => {
    await waitFor(
      async () => {
        const current = await execution(id);
        if (['failed', 'cancelled'].includes(current.status) && current.status !== status) {
          throw new Error(
            `Execution ${id} ${current.status}: ${JSON.stringify(current.error ?? {})}`
          );
        }
        return current.status === status;
      },
      { timeoutMs: EXECUTION_TIMEOUT_MS, message: `execution ${id} to become ${status}` }
    );
    return execution(id);
  };
  const expectNativeDispatch = (since: string, taskTypes: string[]): void => {
    for (const type of taskTypes) {
      expect(getStartedProcesses(type, since).length).toBeGreaterThan(0);
      expect(getDispatchFailures(type, 'declined', since)).toHaveLength(0);
      expect(getDispatchFailures(type, 'not_served', since)).toHaveLength(0);
    }
  };

  apiTest.beforeAll(async ({ apiClient, requestAuth }) => {
    client = apiClient;
    headers = {
      ...(await requestAuth.getApiKey('admin')).apiKeyHeader,
      ...HEADERS,
      'elastic-api-version': '2023-10-31',
    };
    const space = await client.post('api/spaces/space', {
      headers,
      body: { id: spaceId, name: spaceId },
    });
    expect(space).toHaveStatusCode(200);
  });

  apiTest.afterAll(async ({ esClient }) => {
    await esClient.indices.refresh({ index: '.workflows-executions*' });
    for (const id of workflowIds) {
      const response = await client.delete(
        `${prefix}/api/workflows/workflow/${id}?force=true&acknowledgeAclLoss=true`,
        {
          headers,
        }
      );
      expect(response).toHaveStatusCode(200);
    }
    for (const id of connectorIds) {
      expect(
        await client.delete(`${prefix}/api/actions/connector/${id}`, { headers })
      ).toHaveStatusCode(204);
    }
    expect(await client.delete(`api/spaces/space/${spaceId}`, { headers })).toHaveStatusCode(204);
  });

  apiTest(
    'resumes human input and waits for a native child using a scoped Kibana step',
    async ({ apiClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const marker = uniqueName('native-data-view');
      const dataView = await apiClient.post<{ data_view: { id: string } }>(
        `${prefix}/api/data_views/data_view`,
        {
          headers,
          body: { data_view: { title: marker, allowNoIndex: true } },
        }
      );
      expect(dataView).toHaveStatusCode(200);
      const child = await createWorkflow(`  - name: read_space
    type: kibana.request
    with:
      method: GET
      path: /s/${spaceId}/api/data_views
`);
      const parent = await createWorkflow(`  - name: ask
    type: waitForInput
    with:
      message: Continue the native workflow?
      schema:
        type: object
        properties:
          approved:
            type: boolean
        required: [approved]
  - name: child
    type: workflow.execute
    with:
      workflow-id: ${child}
      inputs: {}
  - name: done
    type: console
    with:
      message: Native child completed
`);
      const since = new Date().toISOString();
      const id = await run(parent);
      await waitForStatus(id, 'waiting_for_input');
      await expect
        .poll(
          async () =>
            (await execution(id)).stepExecutions?.find(({ stepId }) => stepId === 'ask')?.status,
          { timeout: STEP_VISIBILITY_TIMEOUT_MS }
        )
        .toBe('waiting_for_input');
      const paused = await execution(id);
      const ask = paused.stepExecutions?.find(({ stepId }) => stepId === 'ask');
      expect(ask).toBeDefined();
      const resumed = await apiClient.post(`${prefix}/api/workflows/executions/${id}/resume`, {
        headers,
        body: { input: { approved: true }, stepExecutionId: ask?.id },
      });
      expect(resumed).toHaveStatusCode(200);
      const completed = await waitForStatus(id, 'completed');
      expect(completed.stepExecutions?.find(({ stepId }) => stepId === 'done')?.status).toBe(
        'completed'
      );
      const children = await client.get<{ results: Execution[] }>(
        `${prefix}/api/workflows/workflow/${child}/executions?size=10`,
        { headers }
      );
      expect(children).toHaveStatusCode(200);
      expect(children.body.results).toHaveLength(1);
      const childExecution = await execution(children.body.results[0].id);
      expect(childExecution.status).toBe('completed');
      expect(JSON.stringify(childExecution.stepExecutions)).toContain(dataView.body.data_view.id);
      expectNativeDispatch(since, ['workflow:run', 'workflow:resume']);
    }
  );

  apiTest(
    'runs an agent with Main registration metadata and a native Elasticsearch tool',
    async ({ apiClient, esClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const index = uniqueName('native-agent-indices');
      const answer = 'Native tool completed.';
      const llm = await startWorkflowLlmStub(index, answer);
      try {
        await esClient.index({
          index,
          document: { message: 'native tool proof' },
          refresh: true,
        });
        const connector = await apiClient.post<{ id: string }>(`${prefix}/api/actions/connector`, {
          headers,
          body: {
            name: uniqueName('native-agent-connector'),
            connector_type_id: '.gen-ai',
            config: {
              apiProvider: 'OpenAI',
              apiUrl: `${llm.url}/v1/chat/completions`,
              defaultModel: 'gpt-4',
            },
            secrets: { apiKey: 'native-test-key' },
          },
        });
        expect(connector).toHaveStatusCode(200);
        connectorIds.push(connector.body.id);
        const workflow = await createWorkflow(`  - name: agent
    type: ai.agent
    connector-id: ${connector.body.id}
    with:
      message: List the Elasticsearch indices matching ${index}
`);
        const since = new Date().toISOString();
        const id = await run(workflow);
        const completed = await waitForStatus(id, 'completed');
        expect(JSON.stringify(completed.stepExecutions)).toContain(answer);
        const toolResults = llm.requests.flatMap(({ messages }) =>
          messages.filter(({ role }) => role === 'tool')
        );
        expect(JSON.stringify(toolResults)).toContain(index);
        expectNativeDispatch(since, ['workflow:run']);
      } finally {
        await llm.stop();
        await esClient.indices.delete({ index, ignore_unavailable: true });
      }
    }
  );

  apiTest(
    'cancels a parked native workflow without resuming its remaining steps',
    async ({ apiClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const workflow = await createWorkflow(`  - name: park
    type: wait
    with:
      duration: 5m
  - name: unexpected
    type: console
    with:
      message: Must not execute after cancellation
`);
      const since = new Date().toISOString();
      const id = await run(workflow);
      await waitForStatus(id, 'waiting');
      expect(
        await apiClient.post(`${prefix}/api/workflows/executions/${id}/cancel`, { headers })
      ).toHaveStatusCode(200);
      const cancelled = await waitForStatus(id, 'cancelled');
      expect(
        cancelled.stepExecutions?.find(({ stepId }) => stepId === 'unexpected')
      ).toBeUndefined();
      expectNativeDispatch(since, ['workflow:run']);
    }
  );
});
