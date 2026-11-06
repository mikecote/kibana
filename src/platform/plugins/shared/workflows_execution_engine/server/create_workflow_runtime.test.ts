/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest } from '@kbn/core/server';
import { coreMock } from '@kbn/core/server/mocks';
import { licensingMock } from '@kbn/licensing-plugin/server/mocks';
import { taskManagerMock } from '@kbn/task-manager-plugin/server/mocks';
import { DeclinedRunError } from '@kbn/task-manager-plugin/server/task_running/errors';

jest.mock('./lib/check_license', () => ({
  checkLicense: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('elastic-apm-node', () => ({
  __esModule: true,
  default: {
    currentTransaction: null,
    startSpan: jest.fn().mockReturnValue({ end: jest.fn() }),
  },
}));
jest.mock('./lib/get_user', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue('test-user'),
}));

const mockGetWorkflow = jest.fn();
jest.mock('@kbn/workflows', () => {
  const actual = jest.requireActual('@kbn/workflows');
  return {
    ...actual,
    WorkflowRepository: jest.fn().mockImplementation(() => ({
      getWorkflow: mockGetWorkflow,
      isWorkflowEnabled: jest.fn().mockResolvedValue(true),
    })),
  };
});

const mockResolveInterruptedWorkflowRunTask = jest.fn();
const mockResolveInterruptedWorkflowResumeTask = jest.fn();
jest.mock('./lib/task_recovery', () => {
  const actual = jest.requireActual('./lib/task_recovery');
  return {
    ...actual,
    resolveInterruptedWorkflowRunTask: (...args: unknown[]) =>
      mockResolveInterruptedWorkflowRunTask(...args),
    resolveInterruptedWorkflowResumeTask: (...args: unknown[]) =>
      mockResolveInterruptedWorkflowResumeTask(...args),
  };
});
jest.mock('./execution_functions/handle_post_execution_loop', () => ({
  handlePostExecutionLoop: jest.fn().mockResolvedValue(undefined),
}));

const mockRunWorkflow = jest.fn();
const mockResumeWorkflow = jest.fn();
const mockCancelWorkflow = jest.fn();
jest.mock('./execution_functions', () => {
  const actual = jest.requireActual('./execution_functions');
  return {
    ...actual,
    runWorkflow: (...args: unknown[]) => mockRunWorkflow(...args),
    resumeWorkflow: (...args: unknown[]) => mockResumeWorkflow(...args),
    cancelWorkflow: (...args: unknown[]) => mockCancelWorkflow(...args),
    checkAndSkipIfExistingScheduledExecution: jest.fn().mockResolvedValue({ skipped: false }),
  };
});

const mockGetWorkflowExecutionById = jest.fn();
const mockCreateWorkflowExecution = jest.fn().mockResolvedValue(undefined);
jest.mock('./repositories/workflow_execution_repository', () => ({
  WorkflowExecutionRepository: jest.fn().mockImplementation(() => ({
    getWorkflowExecutionById: mockGetWorkflowExecutionById,
    createWorkflowExecution: mockCreateWorkflowExecution,
  })),
}));

import { createWorkflowRuntime } from './create_workflow_runtime';
import type { WorkflowRuntimeDeps } from './create_workflow_runtime';
import { ExecutionIdentityContexts } from './service_account_execution';
import { HitlLifecycleAuditRegistry } from './step/wait_for_input_step/hitl_lifecycle_auditor';
import { createDataClientJestMock } from './test_utils/data_client_jest_mock';
import {
  WORKFLOW_RESUME_TASK_TYPE,
  WORKFLOW_RUN_TASK_TYPE,
  WORKFLOW_SCHEDULED_TASK_TYPE,
} from './workflow_task_manager/types';
import { getWorkflowImmediateResumeTaskId } from './workflow_task_manager/workflow_task_manager';

describe('createWorkflowRuntime', () => {
  const fakeRequest = {} as KibanaRequest;
  const taskInstance = (overrides: Record<string, unknown>) =>
    ({
      ...taskManagerMock.createTask(),
      attempts: 1,
      runAt: new Date('2024-01-01T10:00:00Z'),
      scheduledAt: new Date('2024-01-01T09:55:00Z'),
      ...overrides,
    } as never);

  const createDeps = (overrides: Partial<WorkflowRuntimeDeps> = {}) => {
    const coreStart = coreMock.createStart();
    const context = coreMock.createPluginInitializerContext({
      logging: { console: false },
      eventDriven: { enabled: true, logEvents: true, maxChainDepth: 10 },
      storage: { source: 'plain_index', dataRetention: '90d' },
    });
    const deps: WorkflowRuntimeDeps = {
      logger: context.logger.get(),
      config: context.config.get(),
      elasticsearch: coreStart.elasticsearch,
      security: coreStart.security,
      userProfile: coreStart.userProfile,
      http: coreStart.http,
      analytics: coreStart.analytics,
      dataStreams: coreStart.dataStreams,
      featureFlags: coreStart.featureFlags,
      actions: { getActionsClientWithRequest: jest.fn() },
      taskManager: taskManagerMock.createStart(),
      workflowsExtensions: {
        isReady: jest.fn().mockResolvedValue(undefined),
        hasStepDefinition: jest.fn().mockReturnValue(false),
        getStepDefinition: jest.fn(),
        getTriggerDefinition: jest.fn(),
      },
      licensing: licensingMock.createStart(),
      dataClients: createDataClientJestMock(),
      ...overrides,
    };
    return { deps, coreStart };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkflow.mockResolvedValue(null);
    mockGetWorkflowExecutionById.mockResolvedValue(null);
    mockResolveInterruptedWorkflowRunTask.mockResolvedValue({ action: 'run_workflow' });
    mockResolveInterruptedWorkflowResumeTask.mockResolvedValue({ action: 'resume_workflow' });
    mockRunWorkflow.mockResolvedValue(undefined);
    mockResumeWorkflow.mockResolvedValue({});
  });

  describe('the start contract', () => {
    it('exposes the operations the plugin contract and other code call', () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      expect(runtime.contract).toEqual(
        expect.objectContaining({
          executeWorkflow: runtime.executeWorkflow,
          executeWorkflowStep: runtime.executeWorkflowStep,
          scheduleWorkflow: runtime.scheduleWorkflow,
          bulkScheduleWorkflow: runtime.bulkScheduleWorkflow,
          cancelWorkflowExecution: runtime.cancelWorkflowExecution,
          cancelAllActiveWorkflowExecutions: runtime.cancelAllActiveWorkflowExecutions,
          resumeWorkflowExecution: runtime.resumeWorkflowExecution,
          triggerEvents: runtime.triggerEvents,
          serviceAccountBindings: expect.anything(),
        })
      );
      expect(runtime.triggerEvents).toEqual(
        expect.objectContaining({
          emitEvent: runtime.emitEvent,
          isEnabled: true,
          maxEventChainDepth: 10,
        })
      );
      expect(typeof runtime.internalResumeWorkflowExecution).toBe('function');
    });

    it('cancels an execution', async () => {
      const { deps } = createDeps();
      const runtime = createWorkflowRuntime(deps);
      const request = {} as KibanaRequest;
      await runtime.cancelWorkflowExecution('exec-1', 'default', request);
      expect(mockCancelWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowExecutionId: 'exec-1',
          spaceId: 'default',
          schedulingRequest: request,
        })
      );
    });

    it('resumes through the task manager it was given (external resume wakes the existing task)', async () => {
      const { deps } = createDeps();
      const taskManager = deps.taskManager as ReturnType<typeof taskManagerMock.createStart>;
      taskManager.runSoon.mockResolvedValue({ id: 'task', forced: false });
      const runtime = createWorkflowRuntime(deps);
      await runtime.internalResumeWorkflowExecution('exec-1', 'default', undefined);
      expect(taskManager.runSoon).toHaveBeenCalled();
    });
  });

  describe('workflow:run', () => {
    const context = (overrides: Record<string, unknown> = {}) => ({
      taskInstance: taskInstance({
        id: 'workflow:exec-1:manual',
        taskType: WORKFLOW_RUN_TASK_TYPE,
        params: { workflowRunId: 'exec-1', spaceId: 'default' },
      }),
      fakeRequest,
      signal: new AbortController().signal,
      setCustomTaskRunEventFields: jest.fn(),
      ...overrides,
    });

    it('runs the workflow with the runtime contract and explicit services', async () => {
      const { deps } = createDeps();
      const runtime = createWorkflowRuntime(deps);
      const ctx = context();
      mockGetWorkflowExecutionById.mockResolvedValue({ status: 'completed', workflowId: 'wf-1' });

      await runtime.runWorkflowTask(ctx).run();

      expect(mockRunWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowRunId: 'exec-1',
          spaceId: 'default',
          fakeRequest,
          workflowsExecutionEngine: runtime.contract,
          internalResumeWorkflowExecution: runtime.internalResumeWorkflowExecution,
          dependencies: expect.objectContaining({
            taskManager: deps.taskManager,
            actions: deps.actions,
            workflowsExtensions: deps.workflowsExtensions,
            coreStart: expect.objectContaining({
              elasticsearch: deps.elasticsearch,
              http: deps.http,
              dataStreams: deps.dataStreams,
            }),
          }),
        })
      );
      expect(ctx.setCustomTaskRunEventFields).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_execution_id: 'exec-1', outcome: 'completed' })
      );
    });

    it('fails the execution instead of running without an identity', async () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      const ctx = context({ fakeRequest: undefined });
      await runtime.runWorkflowTask(ctx).run();
      expect(mockRunWorkflow).not.toHaveBeenCalled();
      expect(ctx.setCustomTaskRunEventFields).toHaveBeenCalledWith(
        expect.objectContaining({ workflow_execution_id: 'exec-1', outcome: 'failed' })
      );
    });

    it('stamps cancelled and aborts the run on cancel', async () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      const ctx = context();
      await runtime.runWorkflowTask(ctx).cancel?.();
      expect(ctx.setCustomTaskRunEventFields).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'cancelled' })
      );
    });

    it('declines before anything is written when the preflight throws', async () => {
      const preflight = jest.fn().mockRejectedValue(new DeclinedRunError('no step'));
      const { deps } = createDeps({ preflight });
      const runtime = createWorkflowRuntime(deps);

      await expect(runtime.runWorkflowTask(context()).run()).rejects.toBeInstanceOf(
        DeclinedRunError
      );

      expect(deps.workflowsExtensions.isReady).toHaveBeenCalled();
      expect(mockResolveInterruptedWorkflowRunTask).not.toHaveBeenCalled();
      expect(mockRunWorkflow).not.toHaveBeenCalled();
    });

    it('cannot run as a service account when the deps say so, even when service accounts are enabled', async () => {
      const coreStart = coreMock.createStart();
      const security = {
        ...coreStart.security,
        serviceAccounts: { ...coreStart.security.serviceAccounts, isEnabled: () => true },
      };
      const seen: boolean[] = [];
      const preflight = jest.fn(async ({ capabilities }) => {
        seen.push(capabilities.canRunAs());
      });
      const base = createDeps({ preflight, security });
      await createWorkflowRuntime(base.deps).runWorkflowTask(context()).run();
      await createWorkflowRuntime({ ...base.deps, canRunAs: () => false })
        .runWorkflowTask(context())
        .run();
      // Kibana's runtime follows the security plugin; a task process's never does.
      expect(seen).toEqual([true, false]);
    });

    it('gives the preflight the capabilities and the persisted definition of the run', async () => {
      const definition = { name: 'wf', steps: [], triggers: [] };
      mockGetWorkflowExecutionById.mockResolvedValue({
        status: 'completed',
        workflowDefinition: definition,
      });
      const preflight = jest.fn(async ({ loadWorkflowDefinition, capabilities }) => {
        expect(await loadWorkflowDefinition()).toBe(definition);
        expect(capabilities.hasStepDefinition('x.y')).toBe(false);
        expect(capabilities.canRunAs()).toBe(false);
      });
      const runtime = createWorkflowRuntime(createDeps({ preflight }).deps);

      await runtime.runWorkflowTask(context()).run();

      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: WORKFLOW_RUN_TASK_TYPE,
          workflowRunId: 'exec-1',
          spaceId: 'default',
        })
      );
      expect(mockRunWorkflow).toHaveBeenCalled();
    });
  });

  describe('workflow:resume', () => {
    const context = (overrides: Record<string, unknown> = {}) => ({
      taskInstance: taskInstance({
        id: getWorkflowImmediateResumeTaskId('exec-1'),
        taskType: WORKFLOW_RESUME_TASK_TYPE,
        params: { workflowRunId: 'exec-1', spaceId: 'default' },
      }),
      fakeRequest,
      signal: new AbortController().signal,
      setCustomTaskRunEventFields: jest.fn(),
      ...overrides,
    });

    it('resumes the workflow with the runtime contract', async () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      mockGetWorkflowExecutionById.mockResolvedValue({ status: 'completed', workflowId: 'wf-1' });

      await runtime.resumeWorkflowTask(context()).run();

      expect(mockResumeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowRunId: 'exec-1',
          workflowsExecutionEngine: runtime.contract,
        })
      );
    });

    it('declines before recovery or any resume work when the preflight throws', async () => {
      const preflight = jest.fn().mockRejectedValue(new DeclinedRunError('no step'));
      const runtime = createWorkflowRuntime(createDeps({ preflight }).deps);

      await expect(runtime.resumeWorkflowTask(context()).run()).rejects.toBeInstanceOf(
        DeclinedRunError
      );

      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: WORKFLOW_RESUME_TASK_TYPE, workflowRunId: 'exec-1' })
      );
      expect(mockResolveInterruptedWorkflowResumeTask).not.toHaveBeenCalled();
      expect(mockResumeWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('workflow:scheduled', () => {
    const params = { workflowId: 'wf-1', spaceId: 'default', triggerType: 'scheduled' };
    const context = (overrides: Record<string, unknown> = {}) => ({
      taskInstance: taskInstance({
        id: 'workflow:wf-1:scheduled',
        taskType: WORKFLOW_SCHEDULED_TASK_TYPE,
        params,
        state: {},
      }),
      fakeRequest,
      signal: new AbortController().signal,
      setCustomTaskRunEventFields: jest.fn(),
      ...overrides,
    });

    it('removes the task of a workflow that no longer exists', async () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      const ctx = context();
      await expect(runtime.scheduledWorkflowTask(ctx).run()).resolves.toEqual({
        state: {},
        shouldDeleteTask: true,
      });
      expect(mockRunWorkflow).not.toHaveBeenCalled();
      expect(ctx.setCustomTaskRunEventFields).toHaveBeenCalledWith({
        workflow_id: 'wf-1',
        space_id: 'default',
        outcome: 'queued_deleted',
      });
    });

    it('creates an execution and runs it inline with the runtime contract', async () => {
      const { deps } = createDeps();
      mockGetWorkflow.mockResolvedValue({
        id: 'wf-1',
        enabled: true,
        yaml: 'name: wf',
        definition: { name: 'wf', enabled: true, triggers: [{ type: 'scheduled' }], steps: [] },
      });
      const runtime = createWorkflowRuntime(deps);

      await runtime.scheduledWorkflowTask(context()).run();

      expect(mockCreateWorkflowExecution).toHaveBeenCalled();
      expect(mockRunWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowsExecutionEngine: runtime.contract,
          fakeRequest,
          dependencies: expect.objectContaining({ taskManager: deps.taskManager }),
        })
      );
    });

    it('declines before reading or creating anything else when the preflight throws', async () => {
      mockGetWorkflow.mockResolvedValue({
        id: 'wf-1',
        enabled: true,
        definition: { name: 'wf', enabled: true, triggers: [], steps: [] },
      });
      const preflight = jest.fn(async ({ loadWorkflowDefinition }) => {
        expect(await loadWorkflowDefinition()).toEqual(expect.objectContaining({ name: 'wf' }));
        throw new DeclinedRunError('no trigger');
      });
      const runtime = createWorkflowRuntime(createDeps({ preflight }).deps);

      await expect(runtime.scheduledWorkflowTask(context()).run()).rejects.toBeInstanceOf(
        DeclinedRunError
      );

      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: WORKFLOW_SCHEDULED_TASK_TYPE, workflowId: 'wf-1' })
      );
      expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
      expect(mockCreateWorkflowExecution).not.toHaveBeenCalled();
      expect(mockRunWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('metering', () => {
    it('reports finished executions to the sink as serializable records', async () => {
      const sink = { report: jest.fn() };
      const runtime = createWorkflowRuntime(
        createDeps({
          metering: sink,
          cloud: { serverless: { projectId: 'project-1' } } as never,
        }).deps
      );
      mockGetWorkflowExecutionById.mockResolvedValue({ status: 'completed', workflowId: 'wf-1' });
      await runtime
        .runWorkflowTask({
          taskInstance: taskInstance({
            id: 'workflow:exec-1:manual',
            params: { workflowRunId: 'exec-1', spaceId: 'default' },
          }),
          fakeRequest,
          signal: new AbortController().signal,
          setCustomTaskRunEventFields: jest.fn(),
        })
        .run();

      const { meteringService, dependencies } = mockRunWorkflow.mock.calls[0][0];
      expect(dependencies.cloudSetup).toEqual({ serverless: { projectId: 'project-1' } });
      await meteringService.reportWorkflowExecution(
        {
          id: 'exec-1',
          workflowId: 'wf-1',
          spaceId: 'default',
          status: 'completed',
          duration: 1000,
          workflowDefinition: { steps: [] },
        },
        dependencies.cloudSetup
      );
      expect(sink.report).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'workflow-execution-exec-1' })
      );
    });

    it('does not meter without a sink', async () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      mockGetWorkflowExecutionById.mockResolvedValue({ status: 'completed', workflowId: 'wf-1' });
      await runtime
        .runWorkflowTask({
          taskInstance: taskInstance({
            id: 'workflow:exec-1:manual',
            params: { workflowRunId: 'exec-1', spaceId: 'default' },
          }),
          fakeRequest,
          signal: new AbortController().signal,
          setCustomTaskRunEventFields: jest.fn(),
        })
        .run();
      expect(mockRunWorkflow.mock.calls[0][0].meteringService).toBeUndefined();
    });
  });

  describe('run-time state', () => {
    it('defaults to the shared instances', () => {
      const runtime = createWorkflowRuntime(createDeps().deps);
      expect(runtime.state.identityContexts).toBeInstanceOf(ExecutionIdentityContexts);
      expect(runtime.state.eventChainContext.set).toEqual(expect.any(Function));
      expect(runtime.state.hitlLifecycle).toBeInstanceOf(HitlLifecycleAuditRegistry);
    });

    it('hands its own state to the run', async () => {
      const state = {
        identityContexts: new ExecutionIdentityContexts(),
        eventChainContext: { get: jest.fn(), set: jest.fn() },
        hitlLifecycle: new HitlLifecycleAuditRegistry(),
      };
      const runtime = createWorkflowRuntime(createDeps({ state }).deps);
      expect(runtime.state).toEqual(state);
      mockGetWorkflowExecutionById.mockResolvedValue({ status: 'completed', workflowId: 'wf-1' });
      await runtime
        .runWorkflowTask({
          taskInstance: taskInstance({
            id: 'workflow:exec-1:manual',
            params: { workflowRunId: 'exec-1', spaceId: 'default' },
          }),
          fakeRequest,
          signal: new AbortController().signal,
          setCustomTaskRunEventFields: jest.fn(),
        })
        .run();
      expect(mockRunWorkflow.mock.calls[0][0].dependencies).toEqual(
        expect.objectContaining({
          identityContexts: state.identityContexts,
          eventChainContext: state.eventChainContext,
          hitlLifecycle: state.hitlLifecycle,
        })
      );
    });
  });
});
