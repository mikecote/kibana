/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup, KibanaRequest, Logger } from '@kbn/core/server';
import type { AttackDiscoveryExecutorOptions } from '@kbn/attack-discovery-schedules-common';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { ManagedWorkflowId } from '@kbn/workflows/managed';
import type {
  GetManagedWorkflowStatusOptions,
  ManagedWorkflowStatusReport,
} from '@kbn/workflows/server/types';
import type {
  GenerationCoreServices,
  GetEventLogIndex,
  GetEventLogger,
  WorkflowsManagementApi,
} from './generation/types';

/**
 * The contribution key under which the discoveries plugin adds, to the task process of the attack
 * discovery rule type, the executor of the rules that run workflows (see `taskTypeContributions` in
 * its `kibana.jsonc`). The rule type's module lives in the elastic assistant plugin, which cannot
 * depend on the discoveries plugin, so the module reads the executor from what plugins contribute.
 */
export const ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS =
  'attack-discovery-workflow-executor';

/** What the scheduled run reads of the workflows extensions: the step registry and the managed status. */
export interface ScheduledWorkflowsExtensions {
  hasStepDefinition: (stepTypeId: string) => boolean;
  initManagedWorkflowsClient: (pluginId: string) => Promise<{
    getWorkflowStatus: (
      id: ManagedWorkflowId,
      options: GetManagedWorkflowStatusOptions
    ) => Promise<ManagedWorkflowStatusReport>;
  }>;
}

/**
 * What the scheduled attack discovery run needs, explicitly: the discoveries plugin hands over what its
 * start contracts offer, and a task process what its host does.
 */
export interface AttackDiscoveryWorkflowExecutorDeps {
  analytics?: AnalyticsServiceSetup;
  /** The authorization checks of the rule's user: `actions.api.get` and `checkPrivilegesWithRequest`. */
  authz: SecurityPluginStart['authz'];
  /** Revokes and grants API keys; only read for a request that is not a fake one. */
  apiKeys: GenerationCoreServices['security']['authc']['apiKeys'];
  basePath: GenerationCoreServices['http']['basePath'];
  elasticsearch: GenerationCoreServices['elasticsearch']['client'];
  featureFlags: GenerationCoreServices['featureFlags'];
  getEventLogIndex: GetEventLogIndex;
  getEventLogger: GetEventLogger;
  getSpaceId: (request: KibanaRequest) => string;
  inference: { getConnectorById: (id: string, request: KibanaRequest) => Promise<unknown> };
  logger: Logger;
  publicBaseUrl?: string;
  workflowsExtensions?: ScheduledWorkflowsExtensions;
  workflowsManagementApi?: WorkflowsManagementApi;
}

export type AttackDiscoveryWorkflowExecutor = (
  options: AttackDiscoveryExecutorOptions
) => Promise<{ state: Record<string, never> }>;

/** What the discoveries plugin contributes: exported as `contribution` from the file `kibana.jsonc` lists. */
export interface AttackDiscoveryWorkflowExecutorContribution {
  /** The step types the plugin registers when the feature flag is on. */
  stepTypeIds: ReadonlySet<string>;
  createWorkflowExecutor: (
    deps: AttackDiscoveryWorkflowExecutorDeps
  ) => AttackDiscoveryWorkflowExecutor;
}
