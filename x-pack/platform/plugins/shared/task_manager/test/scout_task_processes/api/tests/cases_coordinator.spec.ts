/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest, tags } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import { HEADERS, TEST_TIMEOUT_MS, getStartedProcesses, uniqueName, waitFor } from '../fixtures';

interface Execution {
  status: string;
  error?: object;
  stepExecutions?: Array<{ stepId: string; output?: { case?: { id: string } } }>;
}

const caseIdFromExecution = (execution: Execution | undefined): string => {
  const id = execution?.stepExecutions?.find(({ stepId }) => stepId === 'create_case')?.output?.case
    ?.id;
  if (!id) throw new Error('Cases step returned no persisted case id');
  return id;
};

apiTest.describe(
  'Coordinator-placed Cases operations',
  { tag: tags.stateful.classic.filter((tag) => tag.startsWith('@local-')) },
  () => {
    const cases: Array<{ prefix: string; id: string }> = [];
    const workflows: Array<{ prefix: string; id: string }> = [];
    const spaces: string[] = [];
    let cleanupHeaders: Record<string, string>;

    apiTest.afterAll(async ({ apiClient }) => {
      for (const { prefix, id } of cases) {
        expect(
          await apiClient.delete(
            `${prefix}/api/cases?ids=${encodeURIComponent(JSON.stringify([id]))}`,
            { headers: cleanupHeaders }
          )
        ).toHaveStatusCode(204);
      }
      for (const { prefix, id } of workflows) {
        expect(
          await apiClient.delete(
            `${prefix}/api/workflows/workflow/${id}?force=true&acknowledgeAclLoss=true`,
            { headers: cleanupHeaders }
          )
        ).toHaveStatusCode(200);
      }
      for (const id of spaces) {
        expect(
          await apiClient.delete(`api/spaces/space/${id}`, { headers: cleanupHeaders })
        ).toHaveStatusCode(204);
      }
    });

    apiTest(
      'creates a persisted case from a native worker with the workflow caller identity',
      async ({ apiClient, requestAuth }) => {
        apiTest.setTimeout(TEST_TIMEOUT_MS);
        const headers = {
          ...(await requestAuth.getApiKey('admin')).apiKeyHeader,
          ...HEADERS,
          'elastic-api-version': '2023-10-31',
        };
        const spaceId = uniqueName('coordinator-cases');
        const prefix = `s/${spaceId}`;
        const title = uniqueName('coordinator-case');
        cleanupHeaders = headers;
        expect(
          await apiClient.post('api/spaces/space', {
            headers,
            body: { id: spaceId, name: spaceId },
          })
        ).toHaveStatusCode(200);
        spaces.push(spaceId);
        const caller = await apiClient.get<{ username: string }>('internal/security/me', {
          headers,
        });
        expect(caller).toHaveStatusCode(200);
        const workflow = await apiClient.post<{ id: string; valid: boolean }>(
          `${prefix}/api/workflows/workflow`,
          {
            headers,
            body: {
              yaml: `name: ${uniqueName('coordinator-workflow')}
enabled: true
triggers:
  - type: manual
steps:
  - name: create_case
    type: cases.createCase
    with:
      title: ${title}
      description: Created by a worker through the coordinator capability
      owner: securitySolution
      tags: [coordinator-placement]
`,
            },
          }
        );
        expect(workflow).toHaveStatusCode(200);
        const workflowId = workflow.body.id;
        workflows.push({ prefix, id: workflowId });
        expect(workflow.body.valid).toBe(true);
        const since = new Date().toISOString();
        const run = await apiClient.post<{ workflowExecutionId: string }>(
          `${prefix}/api/workflows/workflow/${workflowId}/run`,
          { headers, body: { inputs: {} } }
        );
        expect(run).toHaveStatusCode(200);
        let execution: Execution | undefined;
        await waitFor(
          async () => {
            const response = await apiClient.get<Execution>(
              `${prefix}/api/workflows/executions/${run.body.workflowExecutionId}?includeOutput=true`,
              { headers }
            );
            expect(response).toHaveStatusCode(200);
            execution = response.body;
            if (['failed', 'cancelled'].includes(execution.status)) {
              throw new Error(
                `Cases workflow ${execution.status}: ${JSON.stringify(execution.error)}`
              );
            }
            return execution.status === 'completed';
          },
          { timeoutMs: 120_000, message: 'coordinator Cases workflow completion' }
        );
        const caseId = caseIdFromExecution(execution);
        cases.push({ prefix, id: caseId });
        const persisted = await apiClient.get<{
          title: string;
          owner: string;
          created_by: { username: string };
        }>(`${prefix}/api/cases/${caseId}`, { headers });
        expect(persisted).toHaveStatusCode(200);
        expect(persisted.body.title).toBe(title);
        expect(persisted.body.owner).toBe('securitySolution');
        expect(persisted.body.created_by.username).toBe(caller.body.username);
        expect(getStartedProcesses('workflow:run', since).length).toBeGreaterThan(0);
      }
    );
  }
);
