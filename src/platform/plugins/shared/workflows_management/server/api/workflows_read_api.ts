/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ElasticsearchClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type {
  WorkflowDetailDto,
  WorkflowExecutionDto,
  WorkflowExecutionEngineModel,
} from '@kbn/workflows';
import type { ManagedWorkflowId } from '@kbn/workflows/managed';
import type {
  GetManagedWorkflowStatusOptions,
  ManagedWorkflowStatusReport,
} from '@kbn/workflows/server/types';
import type {
  StepExecutionsDataClient,
  WorkflowExecutionsDataClient,
  WorkflowsExecutionEnginePluginStart,
} from '@kbn/workflows-execution-engine/server';
import { getWorkflowExecution as readWorkflowExecution } from './lib/get_workflow_execution';
import { getManagedWorkflowStatus as readManagedWorkflowStatus } from '../services/managed_workflow_status';
import { WorkflowAccessControlService } from '../services/workflow_access_control';
import type { WorkflowAccessCore } from '../services/workflow_access_control';
import type { WorkflowExecutionStatusItem } from '../services/workflow_execution_query_service';
import { WorkflowReadService } from '../services/workflow_read_service';
import { createStorage } from '../storage/workflow_storage';

type Access = Pick<WorkflowAccessControlService, 'checkAccess' | 'toDto'>;

/**
 * A workflow the request may read, with its permissions. The management API and the read API of a
 * task process share it, so the access decision is the same in both.
 */
export const getWorkflowForRequest = async ({
  getWorkflow,
  access,
  id,
  spaceId,
  request,
}: {
  getWorkflow: (id: string, spaceId: string) => Promise<WorkflowDetailDto | null>;
  access: Access;
  id: string;
  spaceId: string;
  request: KibanaRequest;
}): Promise<WorkflowDetailDto | null> => {
  const workflow = await getWorkflow(id, spaceId);
  if (!workflow) return null;
  if (!(await access.checkAccess(workflow, 'read', request))) return null;
  return access.toDto(workflow, request);
};

/** An execution whose workflow the request may read (or whose workflow no longer exists). */
export const getWorkflowExecutionForRequest = async ({
  getExecution,
  getWorkflow,
  access,
  executionId,
  spaceId,
  options,
}: {
  getExecution: (
    executionId: string,
    spaceId: string,
    options: { includeInput?: boolean; includeOutput?: boolean; omitStepExecutions?: boolean }
  ) => Promise<WorkflowExecutionDto | null>;
  getWorkflow: (
    id: string,
    spaceId: string,
    options: { includeDeleted: boolean }
  ) => Promise<WorkflowDetailDto | null>;
  access: Access;
  executionId: string;
  spaceId: string;
  options: {
    includeInput?: boolean;
    includeOutput?: boolean;
    omitStepExecutions?: boolean;
    request: KibanaRequest;
  };
}): Promise<WorkflowExecutionDto | null> => {
  const execution = await getExecution(executionId, spaceId, options);
  if (!execution) return null;
  if (!execution.workflowId) return execution;
  const workflow = await getWorkflow(execution.workflowId, spaceId, { includeDeleted: true });
  if (workflow) {
    if (!(await access.checkAccess(workflow, 'read', options?.request))) return null;
  }
  return execution;
};

/**
 * Schedules a workflow run in the execution engine and returns the id of its execution. The
 * management API and a task process (which schedules with the same engine function) share it.
 */
export const scheduleWorkflowWithEngine = async ({
  scheduleWorkflow,
  workflow,
  spaceId,
  inputs,
  request,
  triggeredBy,
  metadata,
}: {
  scheduleWorkflow: WorkflowsExecutionEnginePluginStart['scheduleWorkflow'];
  workflow: WorkflowExecutionEngineModel;
  spaceId: string;
  inputs: Record<string, unknown>;
  request: KibanaRequest;
  triggeredBy: string;
  metadata?: object;
}): Promise<string> => {
  const { event, ...manualInputs } = inputs;
  const context: Record<string, unknown> = {
    event,
    spaceId,
    inputs: manualInputs,
    triggeredBy,
  };
  if (metadata) {
    context.metadata = metadata;
  }
  const scheduleResponse = await scheduleWorkflow(workflow, context, request);
  return scheduleResponse.workflowExecutionId;
};

export interface WorkflowsReadApiDeps {
  logger: Logger;
  /** The internal user client. */
  esClient: ElasticsearchClient;
  /** What the access decisions read: the user of the request, the audit log and the user profile. */
  core: WorkflowAccessCore;
  authz?: SecurityPluginStart['authz'];
  /** Built from the definitions Kibana installed: this API never installs an index. */
  workflowExecutionsDataClient: WorkflowExecutionsDataClient;
  stepExecutionsDataClient: StepExecutionsDataClient;
}

export interface WorkflowsReadApi {
  getWorkflow: (
    id: string,
    spaceId: string,
    request: KibanaRequest
  ) => Promise<WorkflowDetailDto | null>;
  getWorkflowExecution: (
    executionId: string,
    spaceId: string,
    options: {
      includeInput?: boolean;
      includeOutput?: boolean;
      omitStepExecutions?: boolean;
      request: KibanaRequest;
    }
  ) => Promise<WorkflowExecutionDto | null>;
  /** The status of each execution the request can read; an id that is missing, in another space or whose workflow it cannot read is left out. */
  getWorkflowExecutionStatuses: (
    executionIds: string[],
    spaceId: string,
    options: { request: KibanaRequest }
  ) => Promise<WorkflowExecutionStatusItem[]>;
  getManagedWorkflowStatus: (
    id: ManagedWorkflowId,
    options: GetManagedWorkflowStatusOptions,
    registeredPluginId: string
  ) => Promise<ManagedWorkflowStatusReport>;
}

/**
 * The reads of the workflows management API that need storage only, built from explicit
 * dependencies: they reuse the reads of the CRUD service and the access control service, never
 * install or update an index (the storage skips mapping updates on read), and are what a task
 * process reads workflows with.
 */
export const createWorkflowsReadApi = ({
  logger,
  esClient,
  core,
  authz,
  workflowExecutionsDataClient,
  stepExecutionsDataClient,
}: WorkflowsReadApiDeps): WorkflowsReadApi => {
  const reader = new WorkflowReadService({
    logger,
    workflowStorage: createStorage({ logger, esClient, readOnly: true }),
  });
  const access = new WorkflowAccessControlService(core, undefined, authz);

  return {
    getWorkflow: (id, spaceId, request) =>
      getWorkflowForRequest({
        getWorkflow: (workflowId, space) => reader.getWorkflow(workflowId, space),
        access,
        id,
        spaceId,
        request,
      }),
    getWorkflowExecution: (executionId, spaceId, options) =>
      getWorkflowExecutionForRequest({
        getExecution: (id, space, readOptions) =>
          readWorkflowExecution({
            workflowExecutionsDataClient,
            stepExecutionsDataClient,
            logger,
            workflowExecutionId: id,
            spaceId: space,
            includeInput: readOptions?.includeInput,
            includeOutput: readOptions?.includeOutput,
            omitStepExecutions: readOptions?.omitStepExecutions,
          }),
        getWorkflow: (id, space, readOptions) => reader.getWorkflow(id, space, readOptions),
        access,
        executionId,
        spaceId,
        options,
      }),
    getWorkflowExecutionStatuses: async (executionIds, spaceId, { request }) => {
      const ids = [...new Set(executionIds)];
      if (ids.length === 0) return [];
      const { items } = await workflowExecutionsDataClient.getByIds(ids, {
        sourceIncludes: ['spaceId', 'workflowId', 'status'],
      });
      const executions = items
        .map(({ document }) => document)
        .filter((execution) => execution.spaceId === spaceId)
        .map(({ id, workflowId, status }) => ({ id, workflowId, status }));
      const readable = new Set<string>();
      await Promise.all(
        [...new Set(executions.map(({ workflowId }) => workflowId).filter(Boolean))].map(
          async (workflowId) => {
            const workflow = await reader.getWorkflow(workflowId, spaceId, {
              includeDeleted: true,
            });
            if (workflow && (await access.checkAccess(workflow, 'read', request))) {
              readable.add(workflowId);
            }
          }
        )
      );
      return executions.filter(({ workflowId }) => readable.has(workflowId));
    },
    getManagedWorkflowStatus: (id, options, registeredPluginId) =>
      readManagedWorkflowStatus({ reader, id, options, registeredPluginId }),
  };
};
