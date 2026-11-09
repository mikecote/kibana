/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest } from '@kbn/scout';
import type { ApiClientFixture } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import {
  HEADERS,
  TEST_TIMEOUT_MS,
  getDispatchFailures,
  getStartedProcesses,
  uniqueName,
} from '../fixtures';

const EXECUTION_TIMEOUT_MS = 120_000;
const STEP_VISIBILITY_TIMEOUT_MS = 30_000;

interface Execution {
  id: string;
  status: string;
  stepExecutions?: Array<{ id: string; stepId: string; status: string; output?: object }>;
}

apiTest.describe('Workflows in native task processes', { tag: ['@local-stateful-classic'] }, () => {
  let client: ApiClientFixture;
  let headers: Record<string, string>;
  const spaceId = uniqueName('native-workflows');
  const prefix = `s/${spaceId}`;
  const workflowIds: string[] = [];

  const createWorkflow = async (steps: string): Promise<string> => {
    const response = await client.post<{ id: string }>(`${prefix}/api/workflows/workflow`, {
      headers,
      body: {
        yaml: `name: ${uniqueName(
          'native-workflow'
        )}\nenabled: true\ntriggers:\n  - type: manual\nsteps:\n${steps}`,
      },
    });
    expect(response).toHaveStatusCode(200);
    workflowIds.push(response.body.id);
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
    await expect
      .poll(async () => (await execution(id)).status, { timeout: EXECUTION_TIMEOUT_MS })
      .toBe(status);
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

  apiTest.afterAll(async () => {
    for (const id of workflowIds) {
      const response = await client.delete(
        `${prefix}/api/workflows/workflow/${id}?force=true&acknowledgeAclLoss=true`,
        {
          headers,
        }
      );
      expect(response).toHaveStatusCode(200);
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
      request:
        method: GET
        path: /api/data_views
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
