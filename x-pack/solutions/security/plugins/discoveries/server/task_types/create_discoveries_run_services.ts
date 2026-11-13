/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import type { ScheduledWorkflowsExtensions } from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type {
  DiscoveriesStepCoreServices,
  DiscoveriesStepPluginServices,
  GetStepServices,
} from '../workflows/step_services';

export interface DiscoveriesRunServicesDeps {
  core: DiscoveriesStepCoreServices;
  authz: DiscoveriesStepPluginServices['security']['authz'];
  getActionsClientWithRequest: DiscoveriesStepPluginServices['actions']['getActionsClientWithRequest'];
  getInference: () => InferenceServerStart;
  getSearchInferenceEndpoints: () => NonNullable<
    DiscoveriesStepPluginServices['searchInferenceEndpoints']
  >;
  workflowsManagementApi: WorkflowsManagementApi;
  workflowsExtensions: ScheduledWorkflowsExtensions;
  spaces?: NonNullable<DiscoveriesStepPluginServices['spaces']>['spacesService'];
}

/** Composes Discovery's services from the native workflow, security, space and inference contracts. */
export const createDiscoveriesRunServices = ({
  core,
  authz,
  getActionsClientWithRequest,
  getInference,
  getSearchInferenceEndpoints,
  workflowsManagementApi,
  workflowsExtensions,
  spaces,
}: DiscoveriesRunServicesDeps): {
  getStartServices: GetStepServices;
  workflowsManagementApi: WorkflowsManagementApi;
} => ({
  workflowsManagementApi,
  getStartServices: async () => ({
    coreStart: core,
    pluginsStart: {
      actions: { getActionsClientWithRequest },
      inference: getInference(),
      searchInferenceEndpoints: getSearchInferenceEndpoints(),
      security: { authz },
      ...(spaces ? { spaces: { spacesService: spaces } } : {}),
      workflowsExtensions,
    },
  }),
});
