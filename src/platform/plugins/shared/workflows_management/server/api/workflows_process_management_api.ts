/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest } from '@kbn/core/server';
import {
  ExecutionStatus,
  toWorkflowExecutionEngineModel,
  type WorkflowExecutionEngineModel,
} from '@kbn/workflows';
import { WorkflowNotFoundError } from '@kbn/workflows/common/errors';
import type {
  ExecuteWorkflowParams,
  ExecuteWorkflowResult,
  WorkflowsManagementApi,
} from './workflows_management_api';
import { scheduleWorkflowWithEngine } from './workflows_read_api';
import type { WorkflowsReadApi } from './workflows_read_api';

const DEFAULT_COMPLETION_TIMEOUT_SEC = 120;
const INITIAL_WAIT_MS = 1_000;
const CHECK_INTERVAL_MS = 2_500;
const FINAL_STATUSES = [
  ExecutionStatus.COMPLETED,
  ExecutionStatus.FAILED,
  ExecutionStatus.WAITING_FOR_INPUT,
];

const waitMs = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

export interface WorkflowsProcessManagementApiDeps {
  readApi: Pick<
    WorkflowsReadApi,
    'assertWorkflowAccess' | 'getWorkflow' | 'getWorkflowExecution' | 'getWorkflowExecutionStatuses'
  >;
  /** Schedules a `workflow:run` task of a workflow and returns its execution id. */
  scheduleWorkflow: (
    workflow: WorkflowExecutionEngineModel,
    context: Record<string, unknown>,
    request: KibanaRequest
  ) => Promise<{ workflowExecutionId: string }>;
  /** Pause between the checks of an execution that is waited for (tests shorten it). */
  checkIntervalMs?: number;
}

/**
 * The management API of the workflows plugin as far as a task process serves it, for the plugins
 * that read it from their setup contract (`workflowsManagement.management`): reading a workflow and
 * an execution, and running a saved workflow, which is scheduled as a `workflow:run` task (the
 * execution runs under its own task, in a process of its own when it can be, or in Kibana) and
 * waited for. What needs the workflows service of Kibana (creating, updating, listing, validating,
 * resuming and cancelling workflows, inline YAML runs, the step and trigger definitions) throws
 * "only available in Kibana": the registrations that need it are not made in a process.
 */
export const createWorkflowsProcessManagementApi = ({
  readApi,
  scheduleWorkflow,
  checkIntervalMs = CHECK_INTERVAL_MS,
}: WorkflowsProcessManagementApiDeps): WorkflowsManagementApi => {
  const schedule = (
    workflow: WorkflowExecutionEngineModel,
    spaceId: string,
    inputs: Record<string, unknown>,
    request: KibanaRequest,
    triggeredBy: string,
    metadata?: object
  ) =>
    scheduleWorkflowWithEngine({
      scheduleWorkflow,
      workflow,
      spaceId,
      inputs,
      request,
      triggeredBy,
      metadata,
    });

  const runWorkflow = async (
    workflow: WorkflowExecutionEngineModel,
    spaceId: string,
    inputs: Record<string, unknown>,
    request: KibanaRequest,
    triggeredBy?: string,
    metadata?: Record<string, unknown>
  ) => {
    if (!workflow.isEphemeral) {
      await readApi.assertWorkflowAccess(workflow.id, spaceId, 'execute', request);
    }
    return schedule(workflow, spaceId, inputs, request, triggeredBy ?? 'manual', metadata);
  };

  const executeWorkflow = async (params: ExecuteWorkflowParams): Promise<ExecuteWorkflowResult> => {
    const {
      spaceId,
      request,
      inputs = {},
      waitForCompletion = true,
      completionTimeoutSec = DEFAULT_COMPLETION_TIMEOUT_SEC,
      triggeredBy,
      metadata,
    } = params;
    if (typeof params.yaml === 'string') {
      throw new Error(
        'Running inline workflow YAML is only available in Kibana, not in a task process'
      );
    }
    const workflowId = (params as { workflowId: string }).workflowId;
    const workflow = await readApi.getWorkflow(workflowId, spaceId, request);
    if (!workflow) throw new WorkflowNotFoundError(workflowId);
    if (!workflow.enabled) {
      throw new Error(`Workflow '${workflowId}' is disabled and cannot be executed.`);
    }
    if (!workflow.valid) {
      throw new Error(`Workflow '${workflowId}' has validation errors and cannot be executed.`);
    }
    if (!workflow.definition) {
      throw new Error(`Workflow '${workflowId}' has no definition and cannot be executed.`);
    }

    const workflowExecutionId = await runWorkflow(
      toWorkflowExecutionEngineModel(workflow),
      spaceId,
      inputs,
      request,
      triggeredBy,
      metadata
    );

    const waitLimit = Date.now() + completionTimeoutSec * 1000;
    await waitMs(Math.min(INITIAL_WAIT_MS, checkIntervalMs));
    let execution: Awaited<ReturnType<typeof readApi.getWorkflowExecution>> | undefined;
    do {
      try {
        execution = await readApi.getWorkflowExecution(workflowExecutionId, spaceId, {
          includeOutput: true,
          request,
        });
        const done = waitForCompletion
          ? execution && FINAL_STATUSES.includes(execution.status)
          : execution;
        if (done && execution) return { workflowExecutionId, execution };
      } catch (e) {
        // Keep polling until timeout; execution documents can lag immediately after scheduling.
      }
      await waitMs(checkIntervalMs);
    } while (Date.now() < waitLimit);
    return { workflowExecutionId, ...(execution ? { execution } : {}), timedOut: true };
  };

  const served = {
    getWorkflow: readApi.getWorkflow,
    getWorkflowExecution: readApi.getWorkflowExecution,
    getWorkflowExecutionStatuses: readApi.getWorkflowExecutionStatuses,
    assertWorkflowAccess: readApi.assertWorkflowAccess,
    runWorkflow,
    scheduleWorkflow: schedule,
    executeWorkflow,
  } as Record<string | symbol, unknown>;

  return new Proxy(served, {
    get: (target, property) => {
      if (property in target) return target[property];
      // Not a thenable, so that awaiting the API does not call it.
      if (property === 'then' || typeof property === 'symbol') return undefined;
      return () => {
        throw new Error(
          `The workflows management API (${property}) is only available in Kibana, not in a task process`
        );
      };
    },
  }) as unknown as WorkflowsManagementApi;
};
