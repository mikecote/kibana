/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest } from '@kbn/core/server';
import { createWorkflowsProcessManagementApi } from './workflows_process_management_api';

const request = {} as KibanaRequest;
const savedWorkflow = {
  id: 'wf-1',
  name: 'wf',
  enabled: true,
  valid: true,
  yaml: 'name: wf',
  definition: { name: 'wf', enabled: true, version: '1', triggers: [], steps: [] },
};

describe('createWorkflowsProcessManagementApi', () => {
  const setup = (overrides: Record<string, unknown> = {}) => {
    const readApi = {
      assertWorkflowAccess: jest.fn().mockResolvedValue(undefined),
      getWorkflow: jest.fn().mockResolvedValue(savedWorkflow),
      getWorkflowExecution: jest.fn().mockResolvedValue({
        id: 'exec-1',
        status: 'completed',
        workflowDefinition: { name: 'wf' },
      }),
      getWorkflowExecutionStatuses: jest.fn(),
      ...overrides,
    };
    const scheduleWorkflow = jest.fn().mockResolvedValue({ workflowExecutionId: 'exec-1' });
    const api = createWorkflowsProcessManagementApi({
      readApi: readApi as never,
      scheduleWorkflow,
      checkIntervalMs: 1,
    });
    return { api, readApi, scheduleWorkflow };
  };

  it('reads workflows and executions with the read API', async () => {
    const { api, readApi } = setup();
    await expect(api.getWorkflow('wf-1', 'default', request)).resolves.toBe(savedWorkflow);
    expect(readApi.getWorkflow).toHaveBeenCalledWith('wf-1', 'default', request);
  });

  it('runs a saved workflow as a scheduled task and waits for its execution', async () => {
    const { api, readApi, scheduleWorkflow } = setup();

    const result = await api.executeWorkflow({
      workflowId: 'wf-1',
      spaceId: 'default',
      request,
      inputs: { a: 1, event: { b: 2 } },
    });

    // Checks that the request may execute it, as Kibana does before it runs it.
    expect(readApi.assertWorkflowAccess).toHaveBeenCalledWith(
      'wf-1',
      'default',
      'execute',
      request
    );
    expect(scheduleWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wf-1', enabled: true }),
      expect.objectContaining({
        spaceId: 'default',
        inputs: { a: 1 },
        event: { b: 2 },
        triggeredBy: 'manual',
      }),
      request
    );
    expect(result).toEqual({
      workflowExecutionId: 'exec-1',
      execution: expect.objectContaining({ id: 'exec-1', status: 'completed' }),
    });
  });

  it('returns the execution that exists when it does not wait for completion', async () => {
    const { api, readApi } = setup();
    readApi.getWorkflowExecution.mockResolvedValue({ id: 'exec-1', status: 'running' });

    const result = await api.executeWorkflow({
      workflowId: 'wf-1',
      spaceId: 'default',
      request,
      waitForCompletion: false,
    });

    expect(result.execution).toEqual(expect.objectContaining({ status: 'running' }));
  });

  it('reports a timeout with the last execution it saw', async () => {
    const { api, readApi } = setup();
    readApi.getWorkflowExecution.mockResolvedValue({ id: 'exec-1', status: 'running' });

    const result = await api.executeWorkflow({
      workflowId: 'wf-1',
      spaceId: 'default',
      request,
      completionTimeoutSec: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({
        timedOut: true,
        execution: expect.objectContaining({ status: 'running' }),
      })
    );
  });

  it.each([
    ['is missing', null, 'not found'],
    ['is disabled', { ...savedWorkflow, enabled: false }, 'disabled'],
    ['is invalid', { ...savedWorkflow, valid: false }, 'validation errors'],
  ])('does not run a workflow that %s', async (_name, workflow, message) => {
    const { api, scheduleWorkflow } = setup({ getWorkflow: jest.fn().mockResolvedValue(workflow) });
    await expect(
      api.executeWorkflow({ workflowId: 'wf-1', spaceId: 'default', request })
    ).rejects.toThrow(new RegExp(message, 'i'));
    expect(scheduleWorkflow).not.toHaveBeenCalled();
  });

  it('does not run inline YAML, nor what needs the workflows service of Kibana', async () => {
    const { api } = setup();
    await expect(
      api.executeWorkflow({ yaml: 'name: x', spaceId: 'default', request })
    ).rejects.toThrow('only available in Kibana');
    expect(() => api.createWorkflow({ yaml: 'x' }, 'default', request)).toThrow(
      'only available in Kibana'
    );
    expect(() => api.getWorkflows({} as never, 'default', { request })).toThrow(
      'only available in Kibana'
    );
  });

  it('is not a thenable, so that awaiting it does not call it', async () => {
    const { api } = setup();
    await expect(Promise.resolve(api)).resolves.toBe(api);
  });
});
