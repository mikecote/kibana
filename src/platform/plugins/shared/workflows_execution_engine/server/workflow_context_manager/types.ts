/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PluginStartContract as ActionsPluginStartContract } from '@kbn/actions-plugin/server';
import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowRepository } from '@kbn/workflows';
import type {
  EventChainContextStore,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import type { WorkflowsExecutionEngineConfig } from '../config';
import type { WorkflowLogEvent } from '../repositories/logs_repository';
import type { StepExecutionRepository } from '../repositories/step_execution_repository';
import type { WorkflowExecutionRepository } from '../repositories/workflow_execution_repository';
import type { ExecutionIdentityContexts } from '../service_account_execution';
import type { HitlLifecycleAuditRegistry } from '../step/wait_for_input_step/hitl_lifecycle_auditor';
import type { WorkflowsExecutionEnginePluginStart } from '../types';
import type {
  WorkflowCloudInfo,
  WorkflowCoreStart,
  WorkflowRuntimeTaskManager,
} from '../workflow_core_services';

export interface ContextDependencies {
  cloudSetup: WorkflowCloudInfo | undefined;
  coreStart: WorkflowCoreStart;
  actions: Pick<ActionsPluginStartContract, 'getActionsClientWithRequest'>;
  taskManager: WorkflowRuntimeTaskManager;
  workflowsExtensions: Pick<
    WorkflowsExtensionsServerPluginStart,
    'isReady' | 'hasStepDefinition' | 'getStepDefinition' | 'getTriggerDefinition'
  >;
  /** Where a run remembers the request that scheduled it; the default when absent. */
  identityContexts?: ExecutionIdentityContexts;
  /** Where a run records its event chain on the request; `setWorkflowEventChainContext` when absent. */
  eventChainContext?: Pick<EventChainContextStore, 'set'>;
  /** Where human-in-the-loop lifecycle events are audited; the default registry when absent. */
  hitlLifecycle?: Pick<HitlLifecycleAuditRegistry, 'emit'>;
  config: WorkflowsExecutionEngineConfig;
  workflowRepository?: WorkflowRepository;
  workflowExecutionRepository?: WorkflowExecutionRepository;
  stepExecutionRepository?: StepExecutionRepository;
  workflowsExecutionEngine?: WorkflowsExecutionEnginePluginStart;
  spaceId?: string;
  request?: KibanaRequest;
}

/**
 * Interface for workflow context manager logging capabilities
 * Used by runtime manager to avoid circular dependencies
 *
 * Simplified interface focusing on actual logging needs
 */
export interface IWorkflowContextLogger {
  // Basic logging methods
  logInfo(message: string, additionalData?: Partial<WorkflowLogEvent>): void;
  logError(message: string, error?: Error, additionalData?: Partial<WorkflowLogEvent>): void;
  logWarn(message: string, additionalData?: Partial<WorkflowLogEvent>): void;
  logDebug(message: string, additionalData?: Partial<WorkflowLogEvent>): void;

  // Timing methods
  startTiming(event: WorkflowLogEvent): void;
  stopTiming(event: WorkflowLogEvent): void;

  // Workflow-level logging
  logWorkflowStart(): void;
  logWorkflowComplete(success?: boolean): void;

  // Step-level logging (no state management needed)
  logStepStart(stepId: string, stepName?: string): void;
  logStepComplete(stepId: string, stepName?: string, success?: boolean): void;
}
