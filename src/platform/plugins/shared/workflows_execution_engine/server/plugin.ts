/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { schema } from '@kbn/config-schema';
import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { TaskRegisterDefinition } from '@kbn/task-manager-plugin/server';
import { WorkflowRepository } from '@kbn/workflows';
import type { WorkflowsExecutionEngineConfig } from './config';
import {
  createWorkflowRuntime,
  WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
  WORKFLOW_RUN_TASK_MAX_ATTEMPTS,
  WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS,
} from './create_workflow_runtime';
import type {
  WorkflowRuntime,
  WorkflowTaskContext,
  WorkflowTaskFunction,
} from './create_workflow_runtime';
import { registerWorkflowDataStreams } from './data_streams';
import { ensureWorkflowsDataStreamsRolledOver } from './lib/data_streams/ensure_data_streams_rolled_over';
import { WorkflowExecutionTelemetryClient } from './lib/telemetry/workflow_execution_telemetry_client';
import { WorkflowsMeteringService } from './metering/metering_service';
import { createDataClientBundle, type DataClientBundle } from './repositories/data_access_layer';
import { WORKFLOW_SERVICE_ACCOUNT_TYPE } from './service_account_execution';
import { resolveWorkflowWorkloads } from './service_account_workload_resolver';
import { WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID } from './task_process_settings';
import type {
  WorkflowsExecutionEnginePluginSetup,
  WorkflowsExecutionEnginePluginSetupDeps,
  WorkflowsExecutionEnginePluginStart,
  WorkflowsExecutionEnginePluginStartDeps,
} from './types';
import type { WorkflowCloudInfo } from './workflow_core_services';
import {
  WORKFLOW_RESUME_TASK_TYPE,
  WORKFLOW_RUN_TASK_TYPE,
  WORKFLOW_SCHEDULED_TASK_TYPE,
} from './workflow_task_manager/types';

type CancellableTask = ReturnType<TaskRegisterDefinition['createTaskRunner']>;

interface SetupDependencies {
  cloudSetup: WorkflowCloudInfo | undefined;
}

/**
 * The plugin owns what only Kibana does: registering the task types, the data streams, the service
 * account workload and the telemetry events, installing the execution indices and rolling the data
 * streams over. Everything a run does lives in the workflow runtime (`createWorkflowRuntime`), which
 * the plugin builds from Kibana's services the first time something needs it.
 */
export class WorkflowsExecutionEnginePlugin
  implements
    Plugin<
      WorkflowsExecutionEnginePluginSetup,
      WorkflowsExecutionEnginePluginStart,
      WorkflowsExecutionEnginePluginSetupDeps,
      WorkflowsExecutionEnginePluginStartDeps
    >
{
  private readonly logger: Logger;
  private readonly config: WorkflowsExecutionEngineConfig;
  private setupDependencies?: SetupDependencies;
  private coreSetup?: CoreSetup<
    WorkflowsExecutionEnginePluginStartDeps,
    WorkflowsExecutionEnginePluginStart
  >;
  private meteringService?: WorkflowsMeteringService;
  private dataClientBundle!: DataClientBundle;

  /** One runtime per Kibana node, built from `start()`'s services (or `getStartServices` if a task comes first). */
  private runtimePromise?: Promise<WorkflowRuntime>;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
    this.config = initializerContext.config.get<WorkflowsExecutionEngineConfig>();
  }

  public setup(
    core: CoreSetup<WorkflowsExecutionEnginePluginStartDeps, WorkflowsExecutionEnginePluginStart>,
    plugins: WorkflowsExecutionEnginePluginSetupDeps
  ) {
    this.logger.debug('Workflows execution engine setup');

    // Register telemetry event schemas
    WorkflowExecutionTelemetryClient.setup(core.analytics);

    const logger = this.logger;
    const config = this.config;

    this.coreSetup = core;
    core.security.serviceAccounts.registerWorkloadType({
      type: WORKFLOW_SERVICE_ACCOUNT_TYPE,
      name: 'Workflow',
      resolveWorkloads: async (workloads, options) => {
        const [coreStart] = await core.getStartServices();
        return resolveWorkflowWorkloads(
          new WorkflowRepository({
            esClient: coreStart.elasticsearch.client.asInternalUser,
            logger,
          }),
          workloads,
          options
        );
      },
    });

    // What a task process that schedules workflows (such as a rule that runs workflows) reads of this plugin.
    plugins.alerting?.registerTaskProcessSettings(
      WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID,
      () => this.config
    );

    // The logs, trigger events and (for `data_stream` storage) execution data streams, from the one
    // module that lists the definitions.
    registerWorkflowDataStreams(core, config.storage);

    this.dataClientBundle = createDataClientBundle({
      source: config.storage.source,
      dataRetention: config.storage.dataRetention,
      logger: this.logger,
    });
    void this.dataClientBundle.initSetup(core);

    const setupDependencies: SetupDependencies = { cloudSetup: plugins.cloud };
    this.setupDependencies = setupDependencies;

    // Initialize metering from the centralized Usage API plugin
    if (plugins.usageApi?.usageReporting) {
      this.meteringService = new WorkflowsMeteringService(
        plugins.usageApi?.usageReporting,
        this.logger.get('workflowsMetering')
      );
      this.logger.debug('Workflows metering service initialized');
    } else {
      this.logger.debug(
        'Workflows metering service not initialized: Usage API plugin is not available or not configured'
      );
    }

    plugins.taskManager.registerTaskDefinitions({
      [WORKFLOW_RUN_TASK_TYPE]: {
        title: 'Run Workflow',
        description: 'Executes a workflow immediately',
        // Set high timeout for long-running workflows.
        // This is high value to allow long-running workflows.
        // The workflow timeout logic defined in workflow execution engine logic is the primary control.
        timeout: '365d',
        // Retries allow `resolveInterruptedWorkflowRunTask` to fail-fast abandoned executions after interrupt.
        maxAttempts: WORKFLOW_RUN_TASK_MAX_ATTEMPTS,
        createTaskRunner: this.createTaskRunner((runtime) => runtime.runWorkflowTask),
      },
    });
    plugins.taskManager.registerTaskDefinitions({
      [WORKFLOW_RESUME_TASK_TYPE]: {
        paramsSchema: schema.object({
          workflowRunId: schema.string(),
          spaceId: schema.string(),
        }),
        title: 'Resume Workflow',
        description: 'Resumes a paused workflow',
        allowPriorityOverride: true,
        // Set high timeout for long-running workflows.
        // This is high value to allow long-running workflows.
        // The workflow timeout logic defined in workflow execution engine logic is the primary control.
        timeout: '365d',
        // Retries allow `resolveInterruptedWorkflowResumeTask` to fail-fast abandoned executions after interrupt.
        maxAttempts: WORKFLOW_RESUME_TASK_MAX_ATTEMPTS,
        createTaskRunner: this.createTaskRunner((runtime) => runtime.resumeWorkflowTask),
      },
    });
    plugins.taskManager.registerTaskDefinitions({
      [WORKFLOW_SCHEDULED_TASK_TYPE]: {
        title: 'Scheduled Workflow Execution',
        description: 'Executes workflows on a scheduled basis',
        // Set high timeout for long-running workflows.
        // This is high value to allow long-running workflows.
        // The workflow timeout logic defined in workflow execution engine logic is the primary control.
        timeout: '365d',
        maxAttempts: WORKFLOW_SCHEDULED_TASK_MAX_ATTEMPTS,
        createTaskRunner: this.createTaskRunner((runtime) => runtime.scheduledWorkflowTask),
      },
    });

    return {};
  }

  public start(coreStart: CoreStart, plugins: WorkflowsExecutionEnginePluginStartDeps) {
    this.logger.debug('workflows-execution-engine: Start');

    if (!this.setupDependencies) {
      throw new Error('Setup not called before start');
    }

    void this.dataClientBundle.initStart(coreStart);

    void ensureWorkflowsDataStreamsRolledOver(
      this.logger.get('data-stream-rollover'),
      coreStart.elasticsearch.client.asInternalUser
    );

    const runtime = this.buildRuntime(coreStart, plugins);
    this.runtimePromise = Promise.resolve(runtime);
    return runtime.contract;
  }

  public stop() {
    void this.dataClientBundle.stop();
  }

  /** Kibana's services, as the explicit dependencies of the runtime. */
  private buildRuntime(
    coreStart: CoreStart,
    plugins: WorkflowsExecutionEnginePluginStartDeps
  ): WorkflowRuntime {
    return createWorkflowRuntime({
      logger: this.logger,
      config: this.config,
      elasticsearch: coreStart.elasticsearch,
      security: coreStart.security,
      userProfile: coreStart.userProfile,
      http: coreStart.http,
      analytics: coreStart.analytics,
      dataStreams: coreStart.dataStreams,
      featureFlags: coreStart.featureFlags,
      spaces: plugins.spaces?.spacesService,
      actions: plugins.actions,
      taskManager: plugins.taskManager,
      workflowsExtensions: plugins.workflowsExtensions,
      licensing: plugins.licensing,
      dataClients: this.dataClientBundle,
      metering: this.meteringService,
      cloud: this.setupDependencies?.cloudSetup,
    });
  }

  /** The runtime of this node; built from the start services when a task runs before `start()` returns. */
  private getRuntime(): Promise<WorkflowRuntime> {
    if (!this.runtimePromise) {
      const { coreSetup } = this;
      if (!coreSetup) {
        return Promise.reject(new Error('Setup not called before the runtime was needed'));
      }
      this.runtimePromise = coreSetup
        .getStartServices()
        .then(([coreStart, plugins]) => this.buildRuntime(coreStart, plugins));
    }
    return this.runtimePromise;
  }

  /**
   * Task Manager needs the runner synchronously, the runtime needs Kibana's start services: the
   * runner is made on the first `run` or `cancel`, once the runtime is available.
   */
  private createTaskRunner(pick: (runtime: WorkflowRuntime) => WorkflowTaskFunction) {
    return (context: WorkflowTaskContext): CancellableTask => {
      let runner: Promise<CancellableTask> | undefined;
      const getRunner = () =>
        (runner ??= this.getRuntime().then((runtime) => pick(runtime)(context)));
      return {
        run: async () => (await getRunner()).run(),
        cancel: async () => (await getRunner()).cancel?.(),
      };
    };
  }
}
