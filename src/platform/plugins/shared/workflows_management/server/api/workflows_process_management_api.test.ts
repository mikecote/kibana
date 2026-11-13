/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { ExecutionStatus } from '@kbn/workflows';
import { workflowsExecutionEngineMock } from '@kbn/workflows-execution-engine/server/mocks';
import { WorkflowsManagementApi } from './workflows_management_api';
import { createWorkflowsProcessServices } from './workflows_process_management_api';
import { WorkflowsRuntime } from '../runtime/workflows_runtime';

jest.mock('../runtime/workflows_runtime');
jest.mock('./routes/utils/workflow_audit_logging');

const MockRuntime = jest.mocked(WorkflowsRuntime);
const request = httpServerMock.createKibanaRequest();
const workflow = {
  id: 'wf-1',
  name: 'wf',
  enabled: true,
  valid: true,
  yaml: 'name: wf',
  definition: { name: 'wf', enabled: true, version: '1', triggers: [], steps: [] },
};

const setup = () => {
  const flushers: Array<() => Promise<void>> = [];
  const getStartServices = jest.fn();
  const services = createWorkflowsProcessServices({
    logger: loggerMock.create(),
    kibanaVersion: '9.0.0',
    isWorkflowsAvailable: true,
    getStartServices,
    getSpaceId: () => 'default',
    waitUntilReady: async () => ({ ready: true }),
    onRunEnd: (flusher) => flushers.push(flusher),
  });
  const api = services.management;
  const runtime = jest.mocked(MockRuntime.mock.instances[0]);
  const core = coreMock.createStart();
  runtime.getCoreStart.mockResolvedValue(core);
  runtime.getWorkflow.mockResolvedValue(workflow as never);
  runtime.getAccessControl.mockResolvedValue({
    checkAccess: jest.fn().mockResolvedValue(true),
    assertAccess: jest.fn().mockResolvedValue(undefined),
    toDto: jest.fn().mockImplementation((value) => value),
  } as never);
  const engine = workflowsExecutionEngineMock.createStart();
  engine.executeWorkflow.mockResolvedValue({ workflowExecutionId: 'exec-1' });
  runtime.getWorkflowsExecutionEngine.mockResolvedValue(engine);
  runtime.getPluginsStart.mockResolvedValue({
    licensing: { getLicense: async () => ({ hasAtLeast: () => true }) },
    workflowsExecutionEngine: engine,
  } as never);
  runtime.getWorkflowExecution.mockResolvedValue({
    id: 'exec-1',
    status: ExecutionStatus.COMPLETED,
  } as never);
  return { api, services, runtime, engine, flushers, getStartServices };
};

describe('process workflow management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the full management API and passes the runtime dependencies through', () => {
    const { api, getStartServices } = setup();
    expect(api).toBeInstanceOf(WorkflowsManagementApi);
    expect(MockRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ getStartServices }),
      expect.anything(),
      '9.0.0'
    );
  });

  it('reads saved workflows with the shared access checks', async () => {
    const { api, runtime } = setup();
    await expect(api.getWorkflow('wf-1', 'default', request)).resolves.toEqual(workflow);
    const access = await runtime.getAccessControl();
    expect(access.checkAccess).toHaveBeenCalledWith(workflow, 'read', request);
  });

  it('creates workflows through the shared CRUD service', async () => {
    const { api, runtime } = setup();
    runtime.createWorkflow.mockResolvedValue(workflow as never);
    await expect(api.createWorkflow({ yaml: workflow.yaml }, 'default', request)).resolves.toEqual(
      workflow
    );
    expect(runtime.createWorkflow).toHaveBeenCalledWith(
      { yaml: workflow.yaml },
      'default',
      request
    );
  });

  it('executes saved workflows through the shared engine contract', async () => {
    const { api, engine } = setup();
    const result = api.executeWorkflow({
      workflowId: 'wf-1',
      spaceId: 'default',
      request,
      inputs: { value: 1 },
    });
    await jest.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({
      workflowExecutionId: 'exec-1',
      execution: { status: ExecutionStatus.COMPLETED },
    });
    expect(engine.executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wf-1' }),
      expect.objectContaining({ inputs: { value: 1 }, spaceId: 'default' }),
      request
    );
  });

  it('validates and executes inline workflows', async () => {
    const { api, runtime, engine } = setup();
    runtime.validateWorkflow.mockResolvedValue({
      valid: true,
      parsedWorkflow: { name: 'inline', enabled: true, version: '1', triggers: [], steps: [] },
    } as never);
    const result = api.executeWorkflow({ yaml: 'name: inline', spaceId: 'default', request });
    await jest.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ workflowExecutionId: 'exec-1' });
    expect(runtime.validateWorkflow).toHaveBeenCalledWith('name: inline', 'default', request, {
      includeVariableRules: false,
      includeEsqlRules: false,
    });
    expect(engine.executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ isEphemeral: true }),
      expect.anything(),
      request
    );
  });

  it('propagates execution-storage failures instead of turning them into timeouts', async () => {
    const { api, runtime } = setup();
    runtime.getWorkflowExecution.mockRejectedValue(new Error('storage unavailable'));
    const result = api.executeWorkflow({ workflowId: 'wf-1', spaceId: 'default', request });
    const assertion = expect(result).rejects.toThrow('storage unavailable');
    await jest.runAllTimersAsync();
    await assertion;
  });

  it('aborts completion polling when the caller is cancelled', async () => {
    const { api, runtime } = setup();
    runtime.getWorkflowExecution.mockResolvedValue(null);
    const abort = new AbortController();
    const result = api.executeWorkflow({
      workflowId: 'wf-1',
      spaceId: 'default',
      request,
      signal: abort.signal,
    });
    const assertion = expect(result).rejects.toThrow('cancelled');
    await jest.advanceTimersByTimeAsync(1000);
    abort.abort(new Error('cancelled'));
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('checks execution access before cancelling a workflow', async () => {
    const { api, runtime, engine } = setup();
    runtime.getWorkflowExecution.mockResolvedValue({ id: 'exec-1', workflowId: 'wf-1' } as never);
    const access = await runtime.getAccessControl();
    jest.mocked(access.assertAccess).mockRejectedValue(new Error('forbidden'));
    await expect(api.cancelWorkflowExecution('exec-1', 'default', request)).rejects.toThrow(
      'forbidden'
    );
    expect(engine.cancelWorkflowExecution).not.toHaveBeenCalled();
  });

  it('flushes pending indexing and stops the runtime at the end of the execution', async () => {
    const { api, runtime, flushers } = setup();
    const flush = jest.spyOn(api, 'flush');
    await Promise.all(flushers.map((flusher) => flusher()));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(runtime.setStopping).toHaveBeenCalledWith(true);
  });
  it('stops the runtime even when flushing fails', async () => {
    const { api, runtime, flushers } = setup();
    jest.spyOn(api, 'flush').mockRejectedValue(new Error('indexing failed'));
    await expect(Promise.all(flushers.map((flusher) => flusher()))).rejects.toThrow(
      'indexing failed'
    );
    expect(runtime.setStopping).toHaveBeenCalledWith(true);
  });
  it('emits trigger events through the same execution engine and request', async () => {
    const { services, engine } = setup();
    const client = await services.getClient(request);
    await client.emitEvent('test.trigger', { value: 1 });
    expect(client.isWorkflowsAvailable).toBe(true);
    expect(engine.triggerEvents.emitEvent).toHaveBeenCalledWith({
      triggerId: 'test.trigger',
      payload: { value: 1 },
      request,
    });
  });

  it('binds managed workflow operations to each owner and the executing request', async () => {
    const { services, runtime } = setup();
    const first = await services.initManagedWorkflowsClient('first-owner');
    const second = await services.initManagedWorkflowsClient('second-owner');
    const options = { spaceId: 'default' };
    await first.getWorkflowStatus('managed-1' as never, options);
    await second.getWorkflowStatus('managed-2' as never, options);
    expect(runtime.getManagedWorkflowStatus).toHaveBeenNthCalledWith(
      1,
      'managed-1',
      options,
      'first-owner'
    );
    expect(runtime.getManagedWorkflowStatus).toHaveBeenNthCalledWith(
      2,
      'managed-2',
      options,
      'second-owner'
    );
    await first.execute(request, 'managed-1' as never, options);
    expect(runtime.executeManagedWorkflow).toHaveBeenCalledWith(
      'managed-1',
      request,
      options,
      'first-owner'
    );
    await expect(services.initManagedWorkflowsClient('')).rejects.toThrow('pluginId is required');
  });
});
