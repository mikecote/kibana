/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import type { estypes } from '@elastic/elasticsearch';
import Boom from '@hapi/boom';
import type { PluginStartContract as ActionsPluginStartContract } from '@kbn/actions-plugin/server';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SpacesServiceStart } from '@kbn/spaces-plugin/server';
import type { RunContext, TaskRegisterDefinition } from '@kbn/task-manager-plugin/server';
import {
  ExecutionStatus,
  isTerminalStatus,
  isWorkflowStepTriggered,
  toWorkflowExecutionEngineModel,
  WorkflowRepository,
} from '@kbn/workflows';
import type {
  BulkScheduleWorkflowResult,
  EsWorkflowExecution,
  WorkflowExecutionEngineModel,
  WorkflowYaml,
} from '@kbn/workflows';
import {
  WorkflowExecutionInvalidStatusError,
  WorkflowExecutionNotFoundError,
} from '@kbn/workflows/common/errors';
import { defaultEventChainContextStore } from '@kbn/workflows-extensions/server';
import type {
  EventChainContextStore,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import { maybeDrainConcurrencyQueueBeforeEnqueue } from './concurrency/concurrency_queue_drainer';
import { handleConcurrencyBlockedExecution } from './concurrency/maybe_schedule_dormant_queued_run';
import type { WorkflowsExecutionEngineConfig } from './config';
import { createWorkflowScheduler } from './create_workflow_scheduler';
import {
  cancelWorkflow,
  checkAndSkipIfExistingScheduledExecution,
  resumeWorkflow,
  runWorkflow,
} from './execution_functions';
import { handlePostExecutionLoop } from './execution_functions/handle_post_execution_loop';
import type { WorkflowPreflight, WorkflowRunCapabilities } from './lib/assert_runnable_in_process';
import { buildWorkflowExecutionDocument } from './lib/build_workflow_execution_document';
import { checkLicense } from './lib/check_license';
import { ensureBoundExecutionAdmitted } from './lib/ensure_bound_execution_admitted';
import {
  MISSING_EXECUTION_IDENTITY_MESSAGE,
  UNKNOWN_EXECUTION_IDENTITY,
} from './lib/execution_identity';
import { getAuthenticatedUser } from './lib/get_user';
import { checkWorkflowAccess, hasWorkflowAccess } from './lib/has_workflow_access';
import { logWorkflowTaskFailure } from './lib/log_workflow_task_failure';
import {
  bulkScheduleRunTasksOrMarkFailed,
  scheduleRunTaskOrMarkFailed,
} from './lib/schedule_workflow_run_task';
import {
  failExecutionMissingIdentity,
  markScheduledExecutionFailedAfterTaskError,
  resolveExhaustedWorkflowRunTask,
  resolveInterruptedWorkflowResumeTask,
  resolveInterruptedWorkflowRunTask,
} from './lib/task_recovery';
import { validateWorkflowInputs } from './lib/validate_workflow_inputs';
import {
  getExecutionForTaskRunEvent,
  mapExecutionStatusToOutcome,
  mapInterruptCompleteReasonToOutcome,
  stampWorkflowTaskRunEventFields,
} from './lib/workflow_task_run_event_fields';
import { createWorkflowsMeteringReporter } from './metering';
import type { MeteringSink } from './metering';
import type { DataClientBundle } from './repositories/data_access_layer';
import { LogsRepository } from './repositories/logs_repository';
import { StepExecutionRepository } from './repositories/step_execution_repository';
import { WorkflowExecutionRepository } from './repositories/workflow_execution_repository';
import {
  defaultExecutionIdentityContexts,
  getWorkflowOriginalRequest,
} from './service_account_execution';
import type { ExecutionIdentityContexts } from './service_account_execution';
import type { HitlLifecycleAuditRegistry } from './step/wait_for_input_step/hitl_lifecycle_auditor';
import { defaultHitlLifecycleAuditRegistry } from './step/wait_for_input_step/hitl_lifecycle_auditor';
import { TriggerEventHandler } from './trigger_events';
import { initializeTriggerEventsClient } from './trigger_events/event_logs';
import { searchTriggerEventLog as querySearchTriggerEventLog } from './trigger_events/event_logs/trigger_event_log_query';
import type { EmitEvent } from './trigger_events/trigger_event_handler';
import type {
  BulkScheduleWorkflow,
  CancelAllActiveWorkflowExecutions,
  CancelWorkflowExecution,
  ExecuteWorkflow,
  ExecuteWorkflowStep,
  InternalResumeWorkflowExecution,
  ResumeWorkflowExecution,
  ScheduleWorkflow,
  TriggerEventsContract,
  WorkflowsExecutionEnginePluginStart,
} from './types';
import { generateExecutionTaskScope } from './utils';
import type { ContextDependencies } from './workflow_context_manager/types';
import type {
  WorkflowCloudInfo,
  WorkflowCoreStart,
  WorkflowRuntimeTaskManager,
} from './workflow_core_services';
import { WorkflowLogsQueryService } from './workflow_event_logger';
import type {
  ResumeWorkflowExecutionParams,
  StartWorkflowExecutionParams,
} from './workflow_task_manager/types';
import {
  WORKFLOW_RESUME_TASK_TYPE,
  WORKFLOW_RUN_TASK_TYPE,
  WORKFLOW_SCHEDULED_TASK_TYPE,
} from './workflow_task_manager/types';
import {
  getTaskPriority,
  getWorkflowImmediateResumeTaskId,
  getWorkflowWakeTaskId,
  WORKFLOW_PARKED_RUNNER_DELAY_MS,
  WORKFLOW_WAKE_POLL_INTERVAL_MS,
  WorkflowTaskManager,
} from './workflow_task_manager/workflow_task_manager';
import { createWorkflowTaskAbortController } from './workflow_task_shutdown';

/**
 * Max Task Manager attempts for `workflow:run`.
 * - Attempt 1: normal `runWorkflow` execution.
 * - Attempts > 1: `resolveInterruptedWorkflowRunTask` runs first; when it marks the execution FAILED
 *   (interrupt recovery) the runner returns without re-executing user logic - so attempt 2 is not a
 *   second full workflow run in that case.
 * - A third attempt mainly covers transient failures persisting that recovery (e.g. ES unavailable)
 *   or a thrown error on attempt 1 where attempt 2 still runs recovery then `runWorkflow` again;
 *   it is not meant as extra user workflow retries after successful interrupt recovery.
 */
export const WORKFLOW_RUN_TASK_MAX_ATTEMPTS = 3;

/**
 * Max Task Manager attempts for `workflow:resume`.
 * Same numeric budget as run but semantics differ: each attempt can run `resumeWorkflow` user logic
 * until interrupt recovery short-circuits or the last attempt applies `resolveExhaustedWorkflowRunTask`
 * after a handler failure - so extra attempts also cover resume work that runs and may throw.
 */
export const WORKFLOW_RESUME_TASK_MAX_ATTEMPTS = 3;

export const WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS = 3;

/** Batch size for bulk cancel search_after paging (internal; not exposed on the public API). */
const BULK_CANCEL_PAGE_SIZE = 10;

/**
 * Run-time state that would otherwise be module-global. One set lives in each runtime: one per
 * Kibana node, one per task process. Each defaults to the shared default instance, which is what
 * Kibana uses (workflows_management reaches the HITL registry through `registerHitlLifecycleAuditor`).
 */
export interface WorkflowRuntimeState {
  /** Remembers the request that scheduled a run as a service account (was a module `WeakMap`). */
  identityContexts?: ExecutionIdentityContexts;
  /** Records the event chain of a run on its request. */
  eventChainContext?: EventChainContextStore;
  /** Where human-in-the-loop lifecycle events are audited (late-bound by workflows_management). */
  hitlLifecycle?: HitlLifecycleAuditRegistry;
}

/**
 * What the engine needs, explicitly. The execution engine plugin builds it from Core and its start
 * dependencies; a task process builds it from its host. Nothing here is `CoreStart`, a plugin class
 * field or a module-global: install steps (indices, templates, data stream rollover, workload
 * registration, event type registration) stay in the plugin, the runtime takes finished clients.
 */
export interface WorkflowRuntimeDeps {
  logger: Logger;
  config: WorkflowsExecutionEngineConfig;

  /** The internal user client (`client.asInternalUser`) and the scoped client factory (`client.asScoped`). */
  elasticsearch: WorkflowCoreStart['elasticsearch'];
  /** `authc.getCurrentUser`, `audit`, and the workflow service accounts. */
  security: WorkflowCoreStart['security'];
  /** `getCurrentProfileId`, for private workflow access checks. */
  userProfile: WorkflowCoreStart['userProfile'];
  /**
   * What `callKibanaApi`, `kibana.*` steps and the links to Kibana are built from: the self client,
   * the base path (with `publicBaseUrl`) and the server info.
   */
  http: WorkflowCoreStart['http'];
  /** Execution telemetry (`reportEvent`). */
  analytics: WorkflowCoreStart['analytics'];
  /**
   * The execution logs and trigger events data streams: `{ initializeClient(name) }`, Core's
   * `dataStreams` in Kibana, clients built from the shared definitions in a task process.
   */
  dataStreams: WorkflowCoreStart['dataStreams'];
  /** `getBooleanValue$`, for the feature flags a run reads. */
  featureFlags: WorkflowCoreStart['featureFlags'];
  /** The space of a request; absent when Spaces is disabled (everything is the default space). */
  spaces?: Pick<SpacesServiceStart, 'getSpaceId'>;
  /** The scoped actions client factory (connector steps). */
  actions: Pick<ActionsPluginStartContract, 'getActionsClientWithRequest'>;
  /** The Task Manager surface: schedule, bulkSchedule, get, fetch, bulkGet, runSoon, ensureScheduled, removeIfExists, bulkRemove. */
  taskManager: WorkflowRuntimeTaskManager;
  /** The step and trigger registry. */
  workflowsExtensions: Pick<
    WorkflowsExtensionsServerPluginStart,
    'isReady' | 'hasStepDefinition' | 'getStepDefinition' | 'getTriggerDefinition'
  >;
  licensing: Pick<LicensingPluginStart, 'getLicense'>;
  /** The workflow and step execution data clients (the bundle shape of `data_access_layer`). */
  dataClients: Pick<DataClientBundle, 'createWorkflowDataClient' | 'createStepDataClient'>;
  /** Where metering records go; none for no metering (self-managed, or no usage API). */
  metering?: MeteringSink;
  /** The cloud fields used for links to Kibana and by metering. */
  cloud?: WorkflowCloudInfo;
  /** Run-time state that is module-global otherwise. */
  state?: WorkflowRuntimeState;
  /**
   * Called at the top of each task function, before anything is written. It may throw a
   * `DeclinedRunError` to have Task Manager run the task in Kibana. Absent in Kibana.
   */
  preflight?: WorkflowPreflight;
  /** Why a step cannot be served as Kibana would (the preflight declines the run); part of the preflight capabilities. */
  checkStep?: WorkflowRunCapabilities['checkStep'];
  /** Whether a step type is served by a connector (the actions client); part of the preflight capabilities. */
  isConnectorStepType?: (step: { type: string; config: Record<string, unknown> }) => boolean;
}

/** What a task function reads of Task Manager's run context. */
export type WorkflowTaskContext = Pick<
  RunContext,
  'taskInstance' | 'fakeRequest' | 'signal' | 'setCustomTaskRunEventFields'
>;

type CancellableTask = ReturnType<TaskRegisterDefinition['createTaskRunner']>;

/** A task function: builds the runner Task Manager runs and cancels. */
export type WorkflowTaskFunction = (context: WorkflowTaskContext) => CancellableTask;

export interface WorkflowRuntime {
  /** The start contract of the plugin (what other plugins call). */
  contract: WorkflowsExecutionEnginePluginStart;

  /** `workflow:run` */
  runWorkflowTask: WorkflowTaskFunction;
  /** `workflow:resume` */
  resumeWorkflowTask: WorkflowTaskFunction;
  /** `workflow:scheduled` */
  scheduledWorkflowTask: WorkflowTaskFunction;

  executeWorkflow: ExecuteWorkflow;
  executeWorkflowStep: ExecuteWorkflowStep;
  scheduleWorkflow: ScheduleWorkflow;
  bulkScheduleWorkflow: BulkScheduleWorkflow;
  cancelWorkflowExecution: CancelWorkflowExecution;
  cancelAllActiveWorkflowExecutions: CancelAllActiveWorkflowExecutions;
  resumeWorkflowExecution: ResumeWorkflowExecution;
  /** Resumes an execution without the input checks of `resumeWorkflowExecution`; task runners use it for parents. */
  internalResumeWorkflowExecution: InternalResumeWorkflowExecution;
  triggerEvents: TriggerEventsContract;
  emitEvent: EmitEvent;

  /** Applies the concurrency settings of an execution; true when it can proceed. */
  checkConcurrencyIfNeeded: (workflowExecution: Partial<EsWorkflowExecution>) => Promise<boolean>;

  /** The run-time state this runtime uses. */
  state: Required<WorkflowRuntimeState>;
}

export const createWorkflowRuntime = (deps: WorkflowRuntimeDeps): WorkflowRuntime => {
  const {
    logger,
    config,
    elasticsearch,
    security,
    userProfile,
    http,
    analytics,
    dataStreams,
    featureFlags,
    spaces,
    actions,
    taskManager,
    workflowsExtensions,
    licensing,
    dataClients,
    metering,
    cloud,
    preflight,
  } = deps;

  const runtimeState: Required<WorkflowRuntimeState> = {
    identityContexts: deps.state?.identityContexts ?? defaultExecutionIdentityContexts,
    eventChainContext: deps.state?.eventChainContext ?? defaultEventChainContextStore,
    hitlLifecycle: deps.state?.hitlLifecycle ?? defaultHitlLifecycleAuditRegistry,
  };
  const { identityContexts } = runtimeState;

  /** The slice of Core a run reads, assembled from the explicit dependencies. */
  const coreStart: WorkflowCoreStart = {
    elasticsearch,
    security,
    userProfile,
    http,
    analytics,
    dataStreams,
    featureFlags,
  };

  const meteringService = metering ? createWorkflowsMeteringReporter(metering) : undefined;

  const dependencies: ContextDependencies = {
    cloudSetup: cloud,
    coreStart,
    actions,
    taskManager,
    workflowsExtensions,
    config,
    identityContexts,
    eventChainContext: runtimeState.eventChainContext,
    hitlLifecycle: runtimeState.hitlLifecycle,
  };

  const newWorkflowTaskManager = () => new WorkflowTaskManager(taskManager, identityContexts);

  const createScopedRepositories = (): {
    workflowExecutionRepository: WorkflowExecutionRepository;
    stepExecutionRepository: StepExecutionRepository;
  } => {
    const workflowExecutionsDataClient = dataClients.createWorkflowDataClient();
    const stepExecutionsDataClient = dataClients.createStepDataClient();
    return {
      workflowExecutionRepository: new WorkflowExecutionRepository(workflowExecutionsDataClient),
      stepExecutionRepository: new StepExecutionRepository(stepExecutionsDataClient),
    };
  };

  const capabilities: WorkflowRunCapabilities = {
    hasStepDefinition: (stepType) => workflowsExtensions.hasStepDefinition(stepType),
    hasTriggerDefinition: (triggerType) =>
      workflowsExtensions.getTriggerDefinition(triggerType) !== undefined,
    isConnectorStepType: deps.isConnectorStepType,
    checkStep: deps.checkStep,
    canRunAs: () => {
      try {
        return security.serviceAccounts.isEnabled();
      } catch {
        return false;
      }
    },
  };

  const loadExecutionDefinition = async (
    workflowRunId: string,
    spaceId: string
  ): Promise<WorkflowYaml | undefined> => {
    const { workflowExecutionRepository } = createScopedRepositories();
    const execution = await workflowExecutionRepository.getWorkflowExecutionById(
      workflowRunId,
      spaceId
    );
    return execution?.workflowDefinition;
  };

  const loadSavedDefinition = async (
    workflowId: string,
    spaceId: string
  ): Promise<WorkflowYaml | undefined> => {
    const workflow = await new WorkflowRepository({
      esClient: elasticsearch.client.asInternalUser,
      logger,
    }).getWorkflow(workflowId, spaceId, { includeGlobal: true });
    return workflow?.definition ?? undefined;
  };

  /** The declinable pre-flight: runs before anything is written; a no-op without a `preflight`. */
  const runPreflight = async (params: {
    taskType: 'workflow:run' | 'workflow:resume' | 'workflow:scheduled';
    workflowRunId?: string;
    workflowId?: string;
    spaceId: string;
    loadWorkflowDefinition: () => Promise<WorkflowYaml | undefined>;
  }): Promise<void> => {
    if (!preflight) {
      return;
    }
    await workflowsExtensions.isReady();
    let definition: Promise<WorkflowYaml | undefined> | undefined;
    await preflight({
      ...params,
      capabilities,
      loadWorkflowDefinition: () => (definition ??= params.loadWorkflowDefinition()),
    });
  };

  const createMissingIdentityTaskRunner = ({
    workflowRunId,
    spaceId,
    setCustomTaskRunEventFields,
  }: {
    workflowRunId: string;
    spaceId: string;
    setCustomTaskRunEventFields: (fields: Record<string, unknown>) => void;
  }): { run: () => Promise<void>; cancel: () => Promise<void> } => {
    return {
      run: async () => {
        const { workflowExecutionRepository, stepExecutionRepository } = createScopedRepositories();
        await failExecutionMissingIdentity({
          workflowExecutionRepository,
          stepExecutionRepository,
          workflowRunId,
          spaceId,
          logger,
        });
        const execution = await getExecutionForTaskRunEvent(
          workflowExecutionRepository,
          workflowRunId,
          spaceId,
          logger
        );
        stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
          workflow_execution_id: workflowRunId,
          workflow_id: execution?.workflowId,
          space_id: spaceId,
          outcome: 'failed',
        });
      },
      cancel: async () => {
        stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
          workflow_execution_id: workflowRunId,
          space_id: spaceId,
          outcome: 'cancelled',
        });
      },
    };
  };

  const runWorkflowTask: WorkflowTaskFunction = ({
    taskInstance,
    fakeRequest,
    signal,
    setCustomTaskRunEventFields,
  }) => {
    const { workflowRunId, spaceId } = taskInstance.params as StartWorkflowExecutionParams;
    if (!fakeRequest) {
      return createMissingIdentityTaskRunner({
        workflowRunId,
        spaceId,
        setCustomTaskRunEventFields,
      });
    }
    const taskAbortController = createWorkflowTaskAbortController(signal);
    return {
      run: async () => {
        await runPreflight({
          taskType: WORKFLOW_RUN_TASK_TYPE,
          workflowRunId,
          spaceId,
          loadWorkflowDefinition: () => loadExecutionDefinition(workflowRunId, spaceId),
        });
        // Add queue delay metrics to APM trace for observability
        const now = Date.now();
        const scheduledAt = taskInstance.scheduledAt
          ? new Date(taskInstance.scheduledAt).getTime()
          : null;
        const queueDelayMs = scheduledAt ? now - scheduledAt : null;

        const { default: apm } = await import('elastic-apm-node');

        const currentTransaction = apm.currentTransaction;
        if (currentTransaction) {
          if (queueDelayMs !== null) {
            currentTransaction.setLabel('queue_delay_ms', queueDelayMs);
            currentTransaction.setLabel('queue_delay_seconds', Math.round(queueDelayMs / 1000));
          }
          currentTransaction.setLabel('workflow_run_id', workflowRunId);
          currentTransaction.setLabel('space_id', spaceId);
        }
        await checkLicense(licensing);

        const { workflowExecutionRepository, stepExecutionRepository } = createScopedRepositories();

        const interruptedOutcome = await resolveInterruptedWorkflowRunTask({
          workflowExecutionRepository,
          stepExecutionRepository,
          workflowRunId,
          spaceId,
          taskAttempts: taskInstance.attempts,
          logger,
        });

        if (interruptedOutcome.action === 'task_complete') {
          await handlePostExecutionLoop({
            workflowRunId,
            spaceId,
            workflowExecutionRepository,
            stepExecutionRepository,
            internalResumeWorkflowExecution,
            workflowTaskManager: newWorkflowTaskManager(),
            meteringService,
            cloudSetup: cloud,
            logger,
          });
          const outcome = mapInterruptCompleteReasonToOutcome(
            interruptedOutcome.reason,
            interruptedOutcome.execution
          );
          if (outcome) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              workflow_id: interruptedOutcome.execution.workflowId,
              space_id: spaceId,
              outcome,
            });
          }
          return;
        }

        try {
          const runResult = await runWorkflow({
            workflowExecutionRepository,
            stepExecutionRepository,
            workflowRunId,
            spaceId,
            signal: taskAbortController.signal,
            config,
            logger,
            fakeRequest,
            dependencies,
            workflowsExecutionEngine: contract,
            meteringService,
            internalResumeWorkflowExecution,
          });

          // Prefer cancelled when TM aborted the claim so a later stamp does not
          // overwrite cancel's semantic outcome (shared last-write-wins buffer).
          if (taskAbortController.signal.aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            return;
          }

          const execution = await getExecutionForTaskRunEvent(
            workflowExecutionRepository,
            workflowRunId,
            spaceId,
            logger
          );

          if (runResult?.shouldDeleteTask) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              workflow_id: execution?.workflowId,
              space_id: spaceId,
              outcome: 'queued_deleted',
            });
            return {
              state: {},
              shouldDeleteTask: true,
            };
          }

          if (execution) {
            const outcome = mapExecutionStatusToOutcome(execution.status);
            if (outcome) {
              stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
                workflow_execution_id: workflowRunId,
                workflow_id: execution.workflowId,
                space_id: spaceId,
                outcome,
              });
            }
          }
        } catch (error) {
          const aborted = taskAbortController.signal.aborted;
          logWorkflowTaskFailure(logger, error, {
            taskType: WORKFLOW_RUN_TASK_TYPE,
            workflowRunId,
            spaceId,
            taskId: taskInstance.id,
            attempt: taskInstance.attempts,
            maxAttempts: WORKFLOW_RUN_TASK_MAX_ATTEMPTS,
            aborted,
          });
          await resolveExhaustedWorkflowRunTask({
            workflowExecutionRepository,
            stepExecutionRepository,
            workflowRunId,
            spaceId,
            taskAttempts: taskInstance.attempts,
            maxAttempts: WORKFLOW_RUN_TASK_MAX_ATTEMPTS,
            error,
            logger,
          });
          if (aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            throw error;
          }
          const execution = await getExecutionForTaskRunEvent(
            workflowExecutionRepository,
            workflowRunId,
            spaceId,
            logger
          );
          const isExhausted = taskInstance.attempts >= WORKFLOW_RUN_TASK_MAX_ATTEMPTS;
          stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
            workflow_execution_id: workflowRunId,
            workflow_id: execution?.workflowId,
            space_id: spaceId,
            outcome: isExhausted ? 'interrupted' : 'failed',
          });
          throw error;
        }
      },
      cancel: async () => {
        // TM logs task-cancel before invoking this handler; this stamp feeds the
        // shared buffer for a subsequent task-run log if run() finishes after abort.
        stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
          workflow_execution_id: workflowRunId,
          space_id: spaceId,
          outcome: 'cancelled',
        });
        taskAbortController.abort();
      },
    };
  };

  const resumeWorkflowTask: WorkflowTaskFunction = ({
    taskInstance,
    fakeRequest,
    signal,
    setCustomTaskRunEventFields,
  }) => {
    const { workflowRunId, spaceId } = taskInstance.params as ResumeWorkflowExecutionParams;
    if (!fakeRequest) {
      return createMissingIdentityTaskRunner({
        workflowRunId,
        spaceId,
        setCustomTaskRunEventFields,
      });
    }
    const taskAbortController = createWorkflowTaskAbortController(signal);
    return {
      run: async () => {
        await runPreflight({
          taskType: WORKFLOW_RESUME_TASK_TYPE,
          workflowRunId,
          spaceId,
          loadWorkflowDefinition: () => loadExecutionDefinition(workflowRunId, spaceId),
        });
        // Add queue delay metrics to APM trace for observability
        const now = Date.now();
        const scheduledAt = taskInstance.scheduledAt
          ? new Date(taskInstance.scheduledAt).getTime()
          : null;
        const runAt = taskInstance.runAt ? new Date(taskInstance.runAt).getTime() : null;
        const queueDelayMs = scheduledAt ? now - scheduledAt : null;
        const resumeDelayMs = runAt ? now - runAt : null;

        const { default: apm } = await import('elastic-apm-node');
        const currentTransaction = apm.currentTransaction;
        if (currentTransaction) {
          if (queueDelayMs !== null) {
            currentTransaction.setLabel('queue_delay_ms', queueDelayMs);
            currentTransaction.setLabel('queue_delay_seconds', Math.round(queueDelayMs / 1000));
          }
          if (resumeDelayMs !== null) {
            currentTransaction.setLabel('resume_delay_ms', resumeDelayMs);
          }
          currentTransaction.setLabel('workflow_run_id', workflowRunId);
          currentTransaction.setLabel('space_id', spaceId);
        }
        await checkLicense(licensing);

        const { workflowExecutionRepository, stepExecutionRepository } = createScopedRepositories();

        if (taskInstance.id !== getWorkflowWakeTaskId(workflowRunId)) {
          await newWorkflowTaskManager().ensureWakeTask({
            executionId: workflowRunId,
            spaceId,
            fakeRequest,
            runAt: new Date(Date.now() + WORKFLOW_WAKE_POLL_INTERVAL_MS),
          });
        }

        if (taskInstance.id !== getWorkflowImmediateResumeTaskId(workflowRunId)) {
          const retainedWake = taskInstance.id === getWorkflowWakeTaskId(workflowRunId);
          let isUserInteractive = false;
          if (retainedWake) {
            const execution = await workflowExecutionRepository.getWorkflowExecutionById(
              workflowRunId,
              spaceId
            );
            if (!execution || isTerminalStatus(execution.status)) {
              await newWorkflowTaskManager().removeTasksForExecution(workflowRunId, {
                exceptTaskId: taskInstance.id,
              });
              return;
            }
            isUserInteractive =
              execution.context?.pendingInteractiveResume === true &&
              execution.context?.resumeInput != null;
          }
          const accepted = await newWorkflowTaskManager().tryRunImmediateResume({
            executionId: workflowRunId,
            spaceId,
            fakeRequest,
            isUserInteractive,
          });
          // A request never loads workflow checkpoints or invokes steps. Busy
          // runners keep their claim; this notification retries durably in TM.
          if (retainedWake) {
            // Retention closes the ensure-vs-delete race, including approvals written mid-claim.
            return {
              runAt: new Date(Date.now() + (accepted ? WORKFLOW_WAKE_POLL_INTERVAL_MS : 1000)),
              state: {},
              priority: getTaskPriority({ isUserInteractive }),
            };
          }
          return accepted ? undefined : { runAt: new Date(Date.now() + 1000), state: {} };
        }

        const currentExecution = await workflowExecutionRepository.getWorkflowExecutionById(
          workflowRunId,
          spaceId
        );
        if (currentExecution?.status === ExecutionStatus.RUNNING && taskInstance.attempts === 1) {
          // The initial run can still be executing (including short in-process
          // waits). Do not load its mutable checkpoint in a second runner.
          return { runAt: new Date(Date.now() + 1000), state: {} };
        }

        const interruptedOutcome = await resolveInterruptedWorkflowResumeTask({
          workflowExecutionRepository,
          stepExecutionRepository,
          workflowRunId,
          spaceId,
          taskAttempts: taskInstance.attempts,
          logger,
        });

        if (interruptedOutcome.action === 'task_complete') {
          await handlePostExecutionLoop({
            workflowRunId,
            spaceId,
            workflowExecutionRepository,
            stepExecutionRepository,
            internalResumeWorkflowExecution,
            workflowTaskManager: newWorkflowTaskManager(),
            meteringService,
            cloudSetup: cloud,
            logger,
          });
          const outcome = mapInterruptCompleteReasonToOutcome(
            interruptedOutcome.reason,
            interruptedOutcome.execution
          );
          if (outcome) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              workflow_id: interruptedOutcome.execution.workflowId,
              space_id: spaceId,
              outcome,
            });
          }
          return;
        }

        try {
          const { retryAt } = await resumeWorkflow({
            workflowExecutionRepository,
            stepExecutionRepository,
            workflowRunId,
            spaceId,
            signal: taskAbortController.signal,
            config,
            logger,
            fakeRequest,
            dependencies,
            workflowsExecutionEngine: contract,
            meteringService,
            internalResumeWorkflowExecution,
          });

          if (retryAt) return { runAt: retryAt, state: {} };

          if (taskAbortController.signal.aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            return;
          }

          const execution = await getExecutionForTaskRunEvent(
            workflowExecutionRepository,
            workflowRunId,
            spaceId,
            logger
          );
          if (execution) {
            const outcome = mapExecutionStatusToOutcome(execution.status);
            if (outcome) {
              stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
                workflow_execution_id: workflowRunId,
                workflow_id: execution.workflowId,
                space_id: spaceId,
                outcome,
              });
            }
          }
          if (execution && !isTerminalStatus(execution.status)) {
            // Recreating the runner on the next wake-up would grant a new API key.
            return {
              runAt: new Date(Date.now() + WORKFLOW_PARKED_RUNNER_DELAY_MS),
              state: {},
            };
          }
        } catch (error) {
          const aborted = taskAbortController.signal.aborted;
          logWorkflowTaskFailure(logger, error, {
            taskType: WORKFLOW_RESUME_TASK_TYPE,
            workflowRunId,
            spaceId,
            taskId: taskInstance.id,
            attempt: taskInstance.attempts,
            maxAttempts: WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
            aborted,
          });
          await resolveExhaustedWorkflowRunTask({
            workflowExecutionRepository,
            stepExecutionRepository,
            workflowRunId,
            spaceId,
            taskAttempts: taskInstance.attempts,
            maxAttempts: WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
            error,
            logger,
          });
          if (aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowRunId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            throw error;
          }
          const execution = await getExecutionForTaskRunEvent(
            workflowExecutionRepository,
            workflowRunId,
            spaceId,
            logger
          );
          const isExhausted = taskInstance.attempts >= WORKFLOW_RESUME_TASK_MAX_ATTEMPTS;
          stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
            workflow_execution_id: workflowRunId,
            workflow_id: execution?.workflowId,
            space_id: spaceId,
            outcome: isExhausted ? 'interrupted' : 'failed',
          });
          throw error;
        }
      },
      cancel: async () => {
        // TM logs task-cancel before invoking this handler; this stamp feeds the
        // shared buffer for a subsequent task-run log if run() finishes after abort.
        stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
          workflow_execution_id: workflowRunId,
          space_id: spaceId,
          outcome: 'cancelled',
        });
        taskAbortController.abort();
      },
    };
  };

  const scheduledWorkflowTask: WorkflowTaskFunction = ({
    taskInstance,
    fakeRequest,
    signal,
    setCustomTaskRunEventFields,
  }) => {
    const { workflowId, spaceId } = taskInstance.params as {
      workflowId: string;
      spaceId: string;
      triggerType: string;
    };
    if (!fakeRequest) {
      logger.warn(
        `Cannot execute scheduled workflow ${workflowId} in space ${spaceId}: ${MISSING_EXECUTION_IDENTITY_MESSAGE}`
      );
      return {
        run: async () => {
          stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
            workflow_id: workflowId,
            space_id: spaceId,
            outcome: 'failed',
          });
        },
        cancel: async () => {
          stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
            workflow_id: workflowId,
            space_id: spaceId,
            outcome: 'cancelled',
          });
        },
      };
    }
    const taskAbortController = createWorkflowTaskAbortController(signal);
    return {
      run: async () => {
        await runPreflight({
          taskType: WORKFLOW_SCHEDULED_TASK_TYPE,
          workflowId,
          spaceId,
          loadWorkflowDefinition: () => loadSavedDefinition(workflowId, spaceId),
        });
        // Add queue delay metrics to APM trace for observability
        // This shows how long the task waited in the queue before execution
        const now = Date.now();
        const scheduledAt = taskInstance.scheduledAt
          ? new Date(taskInstance.scheduledAt).getTime()
          : null;
        const runAt = taskInstance.runAt ? new Date(taskInstance.runAt).getTime() : null;

        const queueDelayMs = scheduledAt ? now - scheduledAt : null;
        const scheduleDelayMs = runAt ? now - runAt : null;

        // Add labels to current APM transaction for queue visibility
        const { default: apm } = await import('elastic-apm-node');
        const currentTransaction = apm.currentTransaction;
        if (currentTransaction) {
          if (queueDelayMs !== null) {
            currentTransaction.setLabel('queue_delay_ms', queueDelayMs);
            currentTransaction.setLabel('queue_delay_seconds', Math.round(queueDelayMs / 1000));
          }
          if (scheduleDelayMs !== null) {
            currentTransaction.setLabel('schedule_delay_ms', scheduleDelayMs);
          }
          currentTransaction.setLabel('workflow_id', workflowId);
          currentTransaction.setLabel('space_id', spaceId);
        }

        logger.debug(
          `Workflow ${workflowId} queue metrics: queueDelayMs=${queueDelayMs}, scheduleDelayMs=${scheduleDelayMs}`
        );
        await checkLicense(licensing);
        const esClient = coreStart.elasticsearch.client.asInternalUser;

        const workflowRepository = new WorkflowRepository({ esClient, logger });
        const { workflowExecutionRepository, stepExecutionRepository } = createScopedRepositories();

        let workflowExecutionId: string | undefined;
        try {
          const workflow = await workflowRepository.getWorkflow(workflowId, spaceId, {
            includeGlobal: true,
          });
          if (!workflow) {
            // Keep this as error for a while to ensure that such message appears only once per workflow
            logger.error(
              `Workflow ${workflowId} not found in space ${spaceId}; removing orphaned scheduled task`
            );
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'queued_deleted',
            });
            return {
              state: taskInstance.state,
              shouldDeleteTask: true,
            };
          }
          // Document `enabled` is the source of truth. Skip this tick instead of
          // shouldDeleteTask: TM delete is unversioned and uses the same deterministic
          // task id as re-enable, so deleting here can remove a just-rescheduled task.
          if (!workflow.enabled) {
            logger.warn(
              `Workflow ${workflowId} is disabled in space ${spaceId}; skipping leftover scheduled run`
            );
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'skipped',
            });
            return {
              state: taskInstance.state,
            };
          }
          if (
            !(await hasWorkflowAccess(
              workflow,
              fakeRequest,
              coreStart,
              { id: workflowId, spaceId },
              identityContexts
            ))
          ) {
            logger.warn(
              `Skipping scheduled workflow ${workflow.id}: execution access was removed.`
            );
            return { state: taskInstance.state };
          }
          logger.debug(`Running scheduled workflow task for workflow ${workflow.id}`);

          // Overlap / recovery: always run so past-tick abandoned `pending` orphans are
          // reaped even on the first attempt of a new schedule interval. Defer in-flight
          // SKIPPED only when concurrency key+strategy will enforce collisions.
          const concurrency = workflow.definition?.settings?.concurrency;
          const deferInFlightDuplicatesToConcurrency = Boolean(
            concurrency?.key?.trim() && concurrency?.strategy
          );
          const workflowTaskManager = newWorkflowTaskManager();
          const skipResult = await checkAndSkipIfExistingScheduledExecution(
            workflow,
            spaceId,
            workflowExecutionRepository,
            stepExecutionRepository,
            taskInstance,
            logger,
            {
              createSkippedForInFlightDuplicates: !deferInFlightDuplicatesToConcurrency,
              hasActiveTaskForExecution: (executionId) =>
                workflowTaskManager.hasActiveTaskForExecution(executionId),
            }
          );
          if (skipResult.skipped) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: skipResult.workflowExecutionId,
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'skipped',
            });
            return;
          }

          // Check for RRule triggers and log details
          const scheduledTriggers =
            workflow.definition?.triggers?.filter((trigger) => trigger.type === 'scheduled') || [];
          const rruleTriggers = scheduledTriggers.filter(
            (trigger) => trigger.type === 'scheduled' && 'rrule' in (trigger.with || {})
          );

          // Create workflow execution record
          const workflowCreatedAt = new Date();
          const executionContext = {
            workflowRunId: `scheduled-${Date.now()}`,
            spaceId,
            inputs: {},
            event: {
              type: 'scheduled',
              timestamp: new Date().toISOString(),
              source: 'task-manager',
            },
            triggeredBy: 'scheduled',
          };

          // Extract user from fake request (contains API key of user who scheduled the workflow)
          const span = apm.startSpan('workflow get authenticated user', 'workflow', 'execution');
          const executedBy = await getAuthenticatedUser(
            fakeRequest,
            coreStart.security,
            coreStart.elasticsearch.client
          );
          span?.end();

          const workflowExecution = buildWorkflowExecutionDocument({
            workflow: toWorkflowExecutionEngineModel(workflow),
            spaceId,
            context: executionContext,
            defaultTriggeredBy: 'scheduled',
            authenticatedUser: executedBy,
            now: workflowCreatedAt,
            maxEventChainDepth: config.eventDriven.maxChainDepth,
            getConcurrencyGroupKey: (execution) =>
              scheduler.getConcurrencyGroupKey(execution, workflow.definition?.settings),
          });

          workflowExecution.taskRunAt = taskInstance.runAt?.toISOString() ?? null;
          if (config.collectQueueMetrics) {
            workflowExecution.queueMetrics = {
              scheduledAt: taskInstance.scheduledAt?.toString(),
              runAt: taskInstance.runAt?.toString(),
              startedAt: new Date(now).toISOString(),
              queueDelayMs,
              scheduleDelayMs,
            };
          }

          await maybeDrainConcurrencyQueueBeforeEnqueue({
            workflowExecution,
            workflowExecutionRepository,
            workflowTaskManager,
            logger,
            failureLogLabel: 'Scheduled workflow concurrency queue drain failed',
          });

          // Use refresh: 'wait_for' to ensure the execution is immediately searchable
          // for deduplication checks by subsequent scheduled tasks
          await workflowExecutionRepository.createWorkflowExecution(workflowExecution, {
            refresh: 'wait_for',
          });
          await ensureBoundExecutionAdmitted(
            workflowExecution,
            workflowRepository,
            workflowExecutionRepository
          );
          workflowExecutionId = workflowExecution.id;

          if (workflowExecution.status === ExecutionStatus.FAILED) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowExecution.id,
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'failed',
            });
            return;
          }

          // Check concurrency limits and apply collision strategy if needed
          const canProceed = await runtime.checkConcurrencyIfNeeded(workflowExecution);
          if (!canProceed) {
            if (workflowExecution.id && workflowExecution.spaceId) {
              await handleConcurrencyBlockedExecution({
                workflowExecutionId: workflowExecution.id,
                spaceId: workflowExecution.spaceId,
                request: fakeRequest,
                workflowExecutionRepository,
                stepExecutionRepository,
                workflowTaskManager,
                internalResumeWorkflowExecution,
                logger,
              });
              const blockedExecution = await getExecutionForTaskRunEvent(
                workflowExecutionRepository,
                workflowExecution.id,
                workflowExecution.spaceId,
                logger
              );
              if (blockedExecution?.status === ExecutionStatus.SKIPPED) {
                stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
                  workflow_execution_id: workflowExecution.id,
                  workflow_id: workflowId,
                  space_id: spaceId,
                  outcome: 'skipped',
                });
              }
              // QUEUED handoff is non-terminal for the workflow — do not stamp.
            }
            return;
          }

          if (!workflowExecution.id || !workflowExecution.spaceId) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'failed',
            });
            throw new Error('Workflow execution must have id and spaceId');
          }

          // Create-then-fail: scheduled runs start inline (no bound workflow:run). If
          // runWorkflow throws after create, terminalize the still-non-terminal doc so a
          // pending cannot hold a concurrency slot until a later tick reaps it.
          try {
            await runWorkflow({
              workflowRunId: workflowExecution.id,
              spaceId: workflowExecution.spaceId,
              signal: taskAbortController.signal,
              logger,
              config,
              fakeRequest,
              dependencies,
              workflowsExecutionEngine: contract,
              meteringService,
              internalResumeWorkflowExecution,
              workflowExecutionRepository,
              stepExecutionRepository,
            });
          } catch (error) {
            await markScheduledExecutionFailedAfterTaskError({
              workflowExecutionRepository,
              stepExecutionRepository,
              workflowRunId: workflowExecution.id,
              spaceId: workflowExecution.spaceId,
              logger,
            });
            throw error;
          }

          // Prefer cancelled when TM aborted the claim so a later stamp does not
          // overwrite cancel's semantic outcome (shared last-write-wins buffer).
          if (taskAbortController.signal.aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowExecution.id,
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            return;
          }

          const execution = await getExecutionForTaskRunEvent(
            workflowExecutionRepository,
            workflowExecution.id,
            workflowExecution.spaceId,
            logger
          );
          if (execution) {
            const outcome = mapExecutionStatusToOutcome(execution.status);
            if (outcome) {
              stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
                workflow_execution_id: workflowExecution.id,
                workflow_id: workflowId,
                space_id: spaceId,
                outcome,
              });
            }
          }

          const scheduleType = rruleTriggers.length > 0 ? 'RRule' : 'interval/cron';
          logger.debug(`Successfully executed ${scheduleType}-scheduled workflow ${workflow.id}`);
        } catch (error) {
          const aborted = taskAbortController.signal.aborted;
          logWorkflowTaskFailure(logger, error, {
            taskType: WORKFLOW_SCHEDULED_TASK_TYPE,
            workflowId,
            workflowRunId: workflowExecutionId,
            spaceId,
            taskId: taskInstance.id,
            attempt: taskInstance.attempts,
            maxAttempts: WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS,
            aborted,
          });
          if (aborted) {
            stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
              workflow_execution_id: workflowExecutionId,
              workflow_id: workflowId,
              space_id: spaceId,
              outcome: 'cancelled',
            });
            throw error;
          }
          stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
            workflow_execution_id: workflowExecutionId,
            workflow_id: workflowId,
            space_id: spaceId,
            outcome: 'failed',
          });
          throw error;
        }
      },
      async cancel() {
        // TM logs task-cancel before invoking this handler; workflow_execution_id is
        // omitted here (only known after create inside run()).
        stampWorkflowTaskRunEventFields(setCustomTaskRunEventFields, {
          workflow_id: workflowId,
          space_id: spaceId,
          outcome: 'cancelled',
        });
        taskAbortController.abort();
      },
    };
  };

  // The scheduler is built from explicit dependencies, as a task process builds it from its host.
  const scheduler = createWorkflowScheduler({
    taskManager,
    esClient: elasticsearch.client.asInternalUser,
    security,
    userProfile,
    elasticsearch: elasticsearch.client,
    licensing,
    logger,
    config,
    workflowExecutionsDataClient: dataClients.createWorkflowDataClient(),
    stepExecutionsDataClient: dataClients.createStepDataClient(),
    kibanaUrlSource: coreStart,
    cloudSetup: cloud,
    getInternalResumeWorkflowExecution: () => internalResumeWorkflowExecution,
    identityContexts,
  });
  const {
    workflowTaskManager,
    workflowRepository,
    workflowExecutionRepository,
    stepExecutionRepository,
    scheduleDeps,
    scheduleWorkflow,
    ensureWorkflowEnabled,
    buildExecutionDocument,
    createAndPersistWorkflowExecution,
    createTaskInstance,
  } = scheduler;

  const executeWorkflow: ExecuteWorkflow = async (workflow, context, originalRequest) => {
    const request = getWorkflowOriginalRequest(originalRequest);
    await checkLicense(licensing);

    // AUTO-DETECT: Check if we're already running in a Task Manager context
    const isRunningInTaskManager =
      (context.triggeredBy as string | undefined) === 'scheduled' ||
      (context.source as string | undefined) === 'task-manager' ||
      request?.isFakeRequest === true;

    // Child executions (triggered by a workflow step) must always be scheduled in their own task,
    // never run inline in the parent's task. Otherwise the parent's runtime is blocked until the
    // child becomes idle, and cancel/timeout on the parent cannot take effect until then.
    const isChildExecution = isWorkflowStepTriggered(context.triggeredBy as string | undefined);

    if (!isRunningInTaskManager && !request) {
      throw new Error('Workflows cannot be executed without the user context');
    }

    // Test-only hook: simulate slow execution creation so Scout API tests
    // can deterministically reproduce the TOCTOU race in hardDeleteWorkflows.
    // Only honoured for internal API requests (KbnClient sets x-elastic-internal-origin).
    if (request?.isInternalApiRequest) {
      const raw = request.headers['x-kbn-test-run-delay-ms'];
      const delayMs = parseInt(String(Array.isArray(raw) ? raw[0] : raw ?? '0'), 10);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const { workflowExecution } = await createAndPersistWorkflowExecution(
      workflow,
      context,
      'manual',
      originalRequest,
      { refresh: true }
    );

    if (workflowExecution.status === ExecutionStatus.FAILED) {
      return {
        workflowExecutionId: workflowExecution.id,
      };
    }

    const inputsValid = await validateWorkflowInputs(
      workflowExecution,
      workflowExecutionRepository,
      logger,
      coreStart,
      dependencies
    );
    if (!inputsValid) {
      return {
        workflowExecutionId: workflowExecution.id,
      };
    }

    // Check concurrency limits and apply collision strategy if needed
    const canProceed = await runtime.checkConcurrencyIfNeeded(workflowExecution);
    if (!canProceed) {
      if (workflowExecution.id && workflowExecution.spaceId) {
        await handleConcurrencyBlockedExecution({
          workflowExecutionId: workflowExecution.id,
          spaceId: workflowExecution.spaceId,
          request,
          workflowExecutionRepository,
          stepExecutionRepository,
          workflowTaskManager,
          internalResumeWorkflowExecution,
          logger,
        });
      }
      return {
        workflowExecutionId: workflowExecution.id,
      };
    }

    if (isRunningInTaskManager && !isChildExecution) {
      // We're already in a task and this is not a child - execute directly without scheduling another task
      logger.debug(`Executing workflow directly (already in Task Manager context): ${workflow.id}`);

      await runWorkflow({
        workflowExecutionRepository,
        stepExecutionRepository,
        workflowRunId: workflowExecution.id,
        spaceId: workflowExecution.spaceId,
        signal: new AbortController().signal, // TODO: We need to think how to pass this properly from outer task
        logger,
        config,
        fakeRequest: request,
        dependencies,
        workflowsExecutionEngine: contract,
        meteringService,
        internalResumeWorkflowExecution,
      });
    } else {
      // Schedule a task: either we're not in a task, or this is a child execution (must not run inline)
      const taskInstance = createTaskInstance(workflowExecution, ['workflows']);
      await scheduleRunTaskOrMarkFailed(scheduleDeps, taskInstance, request as KibanaRequest);
      logger.debug(
        `Scheduling workflow task for workflow ${workflow.id}, execution ${workflowExecution.id}${
          isChildExecution ? ' (child execution)' : ''
        }`
      );
    }

    return {
      workflowExecutionId: workflowExecution.id,
    };
  };

  const bulkScheduleWorkflow = async (
    items: Array<{ workflow: WorkflowExecutionEngineModel; context: Record<string, unknown> }>,
    originalRequest: KibanaRequest
  ): Promise<BulkScheduleWorkflowResult> => {
    if (items.length === 0) {
      return [];
    }

    await checkLicense(licensing);
    const request = getWorkflowOriginalRequest(originalRequest);

    const authenticatedUser = await getAuthenticatedUser(
      request,
      coreStart.security,
      coreStart.elasticsearch.client
    );
    const now = new Date();

    const results: BulkScheduleWorkflowResult = new Array(items.length);

    const spaceIdFor = (item: (typeof items)[number]) =>
      (item.context.spaceId as string | undefined) || 'default';

    const enabledRefs = items
      .filter((item) => !item.workflow.isEphemeral)
      .map((item) => ({ workflowId: item.workflow.id, spaceId: spaceIdFor(item) }));
    const executionStates = await workflowRepository.getWorkflowExecutionStates(enabledRefs, {
      includeGlobal: true,
    });
    const hasPrivateWorkflows = [...executionStates.values()].some(
      ({ access_control }) => access_control?.access_mode === 'private'
    );
    const profileId = hasPrivateWorkflows
      ? (await coreStart.userProfile.getCurrentProfileId({ request })) ?? undefined
      : undefined;

    interface PreparedItem {
      idx: number;
      workflowExecution: Partial<EsWorkflowExecution>;
    }
    const prepared: PreparedItem[] = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      try {
        const spaceId = spaceIdFor(item);
        if (!item.workflow.isEphemeral) {
          const state = executionStates.get(`${spaceId}:${item.workflow.id}`);
          if (
            state &&
            !checkWorkflowAccess(state, profileId, {
              core: coreStart,
              request,
              id: item.workflow.id,
              spaceId,
            })
          ) {
            throw new Error('You do not have permission to execute this workflow.');
          }
          if (!state?.enabled) {
            throw new Error(
              `Workflow is disabled: ${item.workflow.id}. Enable the workflow to run it.`
            );
          }
        }
        const workflowExecution = await buildExecutionDocument({
          workflow: item.workflow,
          spaceId,
          context: item.context,
          defaultTriggeredBy: 'alert',
          authenticatedUser,
          now,
        });
        prepared.push({ idx, workflowExecution });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[idx] = { status: 'error', error: { message } };
      }
    }

    if (prepared.length === 0) {
      return results;
    }

    // Bulk write all prepared executions in a single _bulk call.
    // `refresh: 'wait_for'` matches the single-item scheduleWorkflow path
    // so downstream concurrency checks see the freshly-written docs.
    const bulkWriteResults = await workflowExecutionRepository.bulkCreateWorkflowExecutions(
      prepared.map((p) => p.workflowExecution),
      { refresh: 'wait_for' }
    );

    // Map per-doc bulk errors back to results; keep succeeded items for the
    // concurrency + task-scheduling passes.
    const succeeded: PreparedItem[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const writeResult = bulkWriteResults[i];
      if ('error' in writeResult) {
        results[p.idx] = {
          status: 'error',
          error: { message: writeResult.error },
        };
      } else {
        try {
          await ensureBoundExecutionAdmitted(
            p.workflowExecution,
            workflowRepository,
            workflowExecutionRepository
          );
          succeeded.push(p);
        } catch (error) {
          results[p.idx] = {
            status: 'error',
            error: { message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
    }

    if (succeeded.length === 0) {
      return results;
    }

    // Every item with a persisted doc returns 'scheduled' with its id, regardless
    // of whether the concurrency check drops it (matches single-item scheduleWorkflow).
    for (const p of succeeded) {
      results[p.idx] = {
        status: 'scheduled',
        workflowExecutionId: p.workflowExecution.id as string,
      };
    }

    const runnable = succeeded.filter((p) => p.workflowExecution.status !== ExecutionStatus.FAILED);

    // Concurrency checks for items in the same group must run sequentially:
    // they read and mutate the same ES state, so running them in parallel
    // would let siblings in one batch see each other as "in flight" and,
    // with max=1 and strategy='drop', drop every item; with
    // 'cancel-in-progress' they would also race to cancel each other.
    // Items without a key, and items in different groups, stay parallel.
    const keylessItems: PreparedItem[] = [];
    const bucketsByGroup = new Map<string, PreparedItem[]>();
    for (const p of runnable) {
      const groupKey = p.workflowExecution.concurrencyGroupKey;
      if (!groupKey) {
        keylessItems.push(p);
      } else {
        const bucketKey = `${p.workflowExecution.spaceId ?? 'default'}:${groupKey}`;
        const existing = bucketsByGroup.get(bucketKey);
        if (existing) {
          existing.push(p);
        } else {
          bucketsByGroup.set(bucketKey, [p]);
        }
      }
    }

    const passingIdx = new Set<number>();
    const runCheck = async (p: PreparedItem) => {
      if (await runtime.checkConcurrencyIfNeeded(p.workflowExecution)) {
        passingIdx.add(p.idx);
        return;
      }

      // `false` means the current execution was queued or terminalized before a task ran.
      // `cancel-in-progress` returns true for the new execution; cancelled older executions
      // resume sync parents through their own running task's normal cancellation path.
      await handleConcurrencyBlockedExecution({
        workflowExecutionId: p.workflowExecution.id as string,
        spaceId: p.workflowExecution.spaceId ?? 'default',
        request,
        workflowExecutionRepository,
        stepExecutionRepository,
        workflowTaskManager,
        internalResumeWorkflowExecution,
        logger,
      });
    };
    await Promise.all([
      ...keylessItems.map(runCheck),
      ...Array.from(bucketsByGroup.values()).map(async (bucket) => {
        for (const p of bucket) {
          await maybeDrainConcurrencyQueueBeforeEnqueue({
            workflowExecution: p.workflowExecution,
            workflowExecutionRepository,
            workflowTaskManager,
            logger,
            failureLogLabel: 'Bulk concurrency queue drain failed',
          });
          await runCheck(p);
        }
      }),
    ]);

    const toSchedule = succeeded.filter((p) => passingIdx.has(p.idx));
    if (toSchedule.length > 0) {
      const tasks = toSchedule.map((p) =>
        createTaskInstance(
          p.workflowExecution,
          generateExecutionTaskScope(p.workflowExecution as EsWorkflowExecution)
        )
      );
      const { failedExecutionIds, message } = await bulkScheduleRunTasksOrMarkFailed(
        scheduleDeps,
        tasks,
        request
      );
      for (const { idx, workflowExecution } of toSchedule) {
        if (failedExecutionIds.has(workflowExecution.id as string)) {
          results[idx] = { status: 'error', error: { message } };
        }
      }
      logger.debug(`Bulk-scheduled ${toSchedule.length} workflow task(s) with user context`);
    }

    return results;
  };

  const executeWorkflowStep: ExecuteWorkflowStep = async (
    workflow,
    stepId,
    executionContext,
    contextOverride,
    request
  ) => {
    await checkLicense(licensing);
    if (workflow.definition?.settings?.run_as) {
      throw Boom.badRequest(
        'Service-account step tests could bypass the saved workflow control flow. Run the complete latest saved workflow instead.'
      );
    }

    const spaceId = workflow.spaceId || 'default';
    await ensureWorkflowEnabled(workflow, spaceId);
    const context: Record<string, unknown> = {
      ...(executionContext ?? {}),
      contextOverride,
      isUserInteractive: true,
    };

    const executedBy = await getAuthenticatedUser(
      request,
      coreStart.security,
      coreStart.elasticsearch.client
    );
    const workflowExecution = await buildExecutionDocument({
      workflow,
      spaceId,
      context,
      defaultTriggeredBy: 'manual',
      authenticatedUser: executedBy,
      now: new Date(),
    });
    workflowExecution.stepId = stepId;

    await workflowExecutionRepository.createWorkflowExecution(workflowExecution);

    if (workflowExecution.status === ExecutionStatus.FAILED) {
      return {
        workflowExecutionId: workflowExecution.id as string,
      };
    }

    const taskInstance = createTaskInstance(
      workflowExecution,
      generateExecutionTaskScope(workflowExecution as EsWorkflowExecution)
    );

    // Use Task Manager's first-class API key support by passing the request.
    // Clone so org/global UIAM keys are granted as TM-managed internal keys.
    // At this point, request is guaranteed to exist due to the early check above
    logger.debug(
      `Scheduling workflow step task with user context for workflow ${workflow.id}, step ${stepId}`
    );
    await scheduleRunTaskOrMarkFailed(scheduleDeps, taskInstance, request);

    return {
      workflowExecutionId: workflowExecution.id as string,
    };
  };

  const cancelWorkflowExecution: CancelWorkflowExecution = async (
    workflowExecutionId,
    spaceId,
    schedulingRequest
  ) => {
    await checkLicense(licensing);

    await cancelWorkflow({
      workflowExecutionId,
      spaceId,
      schedulingRequest,
      workflowExecutionRepository,
      workflowTaskManager,
      logger,
    });
  };

  const cancelAllActiveWorkflowExecutions: CancelAllActiveWorkflowExecutions = async ({
    spaceId,
    workflowId,
    schedulingRequest,
    onCancelled,
  }) => {
    await checkLicense(licensing);

    let searchAfter: estypes.SortResults | undefined;

    do {
      const page = await workflowExecutionRepository.findNonTerminalExecutionIdsByWorkflowIdPage({
        spaceId,
        workflowId,
        size: BULK_CANCEL_PAGE_SIZE,
        searchAfter,
      });

      if (page.results.length === 0) {
        break;
      }

      const outcomes = await Promise.allSettled(
        page.results.map((id) => cancelWorkflowExecution(id, spaceId, schedulingRequest))
      );

      outcomes.forEach((outcome, index) => {
        const executionId = page.results[index];
        if (outcome.status === 'fulfilled') {
          onCancelled?.(executionId);
          return;
        }
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        logger.warn(
          `cancelAllActiveWorkflowExecutions: failed to cancel execution ${executionId}: ${message}`
        );
      });

      searchAfter = page.nextSearchAfter;
    } while (searchAfter !== undefined);
  };

  const resumeWorkflowExecution: ResumeWorkflowExecution = async (
    executionId,
    spaceId,
    input,
    request,
    options
  ) => {
    await checkLicense(licensing);

    const workflowExecution = await workflowExecutionRepository.getWorkflowExecutionById(
      executionId,
      spaceId
    );

    if (!workflowExecution) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }

    if (workflowExecution.status !== ExecutionStatus.WAITING_FOR_INPUT) {
      throw new WorkflowExecutionInvalidStatusError(
        executionId,
        workflowExecution.status,
        ExecutionStatus.WAITING_FOR_INPUT
      );
    }

    // Freshness guard: a waitForInput step whose parent workflow already
    // terminated (timeout, cancel, external failure) can leave the execution
    // doc with `status: waiting_for_input` but `finishedAt` set — writing
    // resumeInput and scheduling a resume task in that state is a no-op that
    // silently swallows the analyst's response. Reject explicitly so the
    // caller sees a 409 and the Inbox provider can surface a real error.
    if (workflowExecution.finishedAt) {
      throw new WorkflowExecutionInvalidStatusError(
        executionId,
        `${workflowExecution.status} (already finished at ${workflowExecution.finishedAt})`,
        ExecutionStatus.WAITING_FOR_INPUT
      );
    }

    const resumedBy =
      options?.resumedBy ??
      (request
        ? (await getAuthenticatedUser(
            request,
            coreStart.security,
            coreStart.elasticsearch.client
          )) ?? UNKNOWN_EXECUTION_IDENTITY
        : UNKNOWN_EXECUTION_IDENTITY);
    const resumedAt = new Date().toISOString();

    const resumeContext = {
      ...workflowExecution.context,
      resumeInput: input,
      resumedBy,
      resumedAt,
      pendingInteractiveResume: request !== undefined,
    };

    await internalResumeWorkflowExecution(executionId, spaceId, resumeContext, request, {
      isUserInteractive: true,
    });

    return { resumedBy };
  };

  const internalResumeWorkflowExecution: InternalResumeWorkflowExecution = async (
    executionId,
    spaceId,
    context,
    request,
    options
  ) => {
    if (context) {
      await workflowExecutionRepository.updateWorkflowExecution({
        id: executionId,
        context,
      });
    }

    if (!request) {
      // External resume: wake the idle-timeout task created when entering WAITING_FOR_INPUT.
      // That task retains the workflow runner API key; ad-hoc tasks scheduled without a
      // request cannot be executed by workflow:resume (no fakeRequest at run time).
      await workflowTaskManager.runExistingResumeTask(executionId);
      return;
    }

    // Preserve the immediate runner's claim and durably retry wake-ups that
    // arrive while it is active.
    await workflowTaskManager.scheduleAndRunImmediateResume({
      executionId,
      spaceId,
      fakeRequest: request,
      isUserInteractive: options?.isUserInteractive,
    });
  };

  const logsRepository = new LogsRepository(dataStreams, logger);
  const workflowEventLoggerService = new WorkflowLogsQueryService(logsRepository, logger);

  const triggerEventsClientPromise = initializeTriggerEventsClient(dataStreams);

  const triggerEventHandler = new TriggerEventHandler({
    workflowExecutionRepository,
    coreStart,
    workflowRepository,
    workflowsExtensions,
    spaces,
    scheduleWorkflow,
    logger,
    config: config.eventDriven,
    triggerEventsClientPromise,
  });

  const emitEvent: EmitEvent = (params) => triggerEventHandler.handleEvent(params);

  const triggerEvents: TriggerEventsContract = {
    emitEvent,
    isEnabled: config.eventDriven.enabled,
    isLogEventsEnabled: config.eventDriven.logEvents,
    maxEventChainDepth: config.eventDriven.maxChainDepth,
    searchTriggerEventLog: async (params) => {
      const triggerEventsClient = await triggerEventsClientPromise;
      return querySearchTriggerEventLog(triggerEventsClient, params);
    },
  };

  const contract: WorkflowsExecutionEnginePluginStart = {
    workflowEventLoggerService,
    executeWorkflow,
    executeWorkflowStep,
    scheduleWorkflow,
    bulkScheduleWorkflow,
    cancelWorkflowExecution,
    cancelAllActiveWorkflowExecutions,
    resumeWorkflowExecution,
    triggerEvents,
    serviceAccountBindings: security.serviceAccounts,
    __internalStorage: {
      workflowExecutionsDataClient: dataClients.createWorkflowDataClient(),
      stepExecutionsDataClient: dataClients.createStepDataClient(),
    },
  };

  const runtime: WorkflowRuntime = {
    contract,
    runWorkflowTask,
    resumeWorkflowTask,
    scheduledWorkflowTask,
    executeWorkflow,
    executeWorkflowStep,
    scheduleWorkflow,
    bulkScheduleWorkflow,
    cancelWorkflowExecution,
    cancelAllActiveWorkflowExecutions,
    resumeWorkflowExecution,
    internalResumeWorkflowExecution,
    triggerEvents,
    emitEvent,
    checkConcurrencyIfNeeded: scheduler.checkConcurrencyIfNeeded,
    state: runtimeState,
  };
  return runtime;
};
