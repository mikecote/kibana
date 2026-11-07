/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PluginStartContract as ActionsStart } from '@kbn/actions-plugin/server';
import type { CoreStart, KibanaRequest } from '@kbn/core/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { WorkflowsExecutionEnginePluginStart } from '@kbn/workflows-execution-engine/server';
import type { WorkflowStepsRegistryView } from '@kbn/workflows-extensions/server';
import type { ManagedInstallReadinessResult } from '../lib/wait_for_managed_workflow_install_readiness';

export interface WorkflowManagementCore {
  elasticsearch: {
    client: Pick<CoreStart['elasticsearch']['client'], 'asInternalUser' | 'asScoped'>;
  };
  security: Pick<CoreStart['security'], 'authc' | 'audit'>;
  userProfile: CoreStart['userProfile'];
  featureFlags: Pick<CoreStart['featureFlags'], 'getBooleanValue$'>;
}

export type WorkflowManagementTaskManager = Pick<
  TaskManagerStartContract,
  'schedule' | 'get' | 'bulkUpdateSchedules' | 'removeIfExists' | 'bulkRemove'
>;

export type WorkflowManagementExtensions = WorkflowStepsRegistryView & {
  getManagedWorkflowPluginIds: () => string[];
};

export interface WorkflowManagementStartServices<
  TCore extends WorkflowManagementCore = WorkflowManagementCore
> {
  core: TCore;
  actions: Pick<ActionsStart, 'getUnsecuredActionsClient' | 'getActionsClientWithRequest'>;
  taskManager: WorkflowManagementTaskManager;
  workflowsExecutionEngine: WorkflowsExecutionEnginePluginStart;
  workflowsExtensions: WorkflowManagementExtensions;
  licensing: Pick<LicensingPluginStart, 'getLicense'>;
  security?: Pick<SecurityPluginStart, 'authz'>;
}

export interface WorkflowManagementRuntimeDependencies<
  TCore extends WorkflowManagementCore = WorkflowManagementCore
> {
  installStorage?: boolean;
  getStartServices: () => Promise<WorkflowManagementStartServices<TCore>>;
  getSpaceId: (request: KibanaRequest) => string;
  waitUntilReady: (
    signal: AbortSignal,
    operation: string
  ) => Promise<ManagedInstallReadinessResult>;
}
