/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import type { ScheduledWorkflowsExtensions } from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { WorkflowExecutionEngineModel } from '@kbn/workflows';
import { scheduleWorkflowWithEngine } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type { WorkflowsReadApi } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type {
  DiscoveriesStepCoreServices,
  DiscoveriesStepPluginServices,
  GetStepServices,
} from '../workflows/step_services';

/** `triggeredBy` of a child workflow that a step runs, when the caller does not name one. */
const DEFAULT_TRIGGERED_BY = 'manual';

export interface DiscoveriesRunServicesDeps {
  /** Core's services, from the host of the process or from `CoreStart`. */
  core: DiscoveriesStepCoreServices;
  authz: DiscoveriesStepPluginServices['security']['authz'];
  getActionsClientWithRequest: DiscoveriesStepPluginServices['actions']['getActionsClientWithRequest'];
  /** Read when a step first needs it. */
  getInference: () => InferenceServerStart;
  getSearchInferenceEndpoints: () => NonNullable<
    DiscoveriesStepPluginServices['searchInferenceEndpoints']
  >;
  /** The reads of the workflows management plugin over the engine's storage. */
  readApi: Pick<
    WorkflowsReadApi,
    'assertWorkflowAccess' | 'getManagedWorkflowStatus' | 'getWorkflow' | 'getWorkflowExecution'
  >;
  /** Schedules a `workflow:run` task of a child workflow and returns its execution id. */
  scheduleWorkflow: (
    workflow: WorkflowExecutionEngineModel,
    context: Record<string, unknown>,
    request: KibanaRequest
  ) => Promise<{ workflowExecutionId: string }>;
  /** Whether a step type is registered in the process. */
  hasStepDefinition: (stepTypeId: string) => boolean;
}

/**
 * What the steps of the discoveries plugin read, built from explicit dependencies: the services of
 * Core and the plugins a task process has, in the shape `plugin.ts` reads from the start contracts.
 *
 * The workflows a step starts (alert retrieval, generation, validation) are scheduled as tasks
 * instead of run inline, as the scheduled attack discovery executor already does: a process serves
 * one run, and the workflow it starts runs under its own `workflow:run` task, in a process of its
 * own under the same process routing policy.
 */
export const createDiscoveriesRunServices = ({
  core,
  authz,
  getActionsClientWithRequest,
  getInference,
  getSearchInferenceEndpoints,
  readApi,
  scheduleWorkflow,
  hasStepDefinition,
}: DiscoveriesRunServicesDeps): {
  getStartServices: GetStepServices;
  workflowsManagementApi: WorkflowsManagementApi;
} => {
  const workflowsExtensions: ScheduledWorkflowsExtensions = {
    hasStepDefinition,
    initManagedWorkflowsClient: async (pluginId: string) => ({
      getWorkflowStatus: (id, options) => readApi.getManagedWorkflowStatus(id, options, pluginId),
    }),
  };

  const schedule: WorkflowsManagementApi['scheduleWorkflow'] = (
    workflow,
    spaceId,
    inputs,
    request,
    triggeredBy
  ) =>
    scheduleWorkflowWithEngine({
      scheduleWorkflow,
      workflow,
      spaceId,
      inputs,
      request,
      triggeredBy: triggeredBy ?? DEFAULT_TRIGGERED_BY,
    });

  const workflowsManagementApi: WorkflowsManagementApi = {
    getWorkflow: readApi.getWorkflow,
    getWorkflowExecution: readApi.getWorkflowExecution,
    scheduleWorkflow: schedule,
    // Kibana checks that the request may execute the workflow before it runs it inline.
    runWorkflow: async (workflow, spaceId, inputs, request, triggeredBy) => {
      if (!workflow.isEphemeral) {
        await readApi.assertWorkflowAccess(workflow.id, spaceId, 'execute', request);
      }
      return schedule(workflow, spaceId, inputs, request, triggeredBy ?? DEFAULT_TRIGGERED_BY);
    },
  };

  const getStartServices: GetStepServices = async () => ({
    coreStart: core,
    pluginsStart: {
      actions: { getActionsClientWithRequest },
      inference: getInference(),
      searchInferenceEndpoints: getSearchInferenceEndpoints(),
      security: { authz },
      // A run has one space: the one its request names.
      spaces: {
        spacesService: {
          getSpaceId: (request: KibanaRequest) =>
            (request as { spaceId?: string } | undefined)?.spaceId ?? 'default',
        },
      },
      workflowsExtensions,
    },
  });

  return { getStartServices, workflowsManagementApi };
};
