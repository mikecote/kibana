/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import { ACTIONS_FEATURE_ID } from '@kbn/actions-plugin/common';
import type { ActionsConfig } from '@kbn/actions-plugin/server/config';
import { EVENT_LOG_PROVIDER as ACTIONS_EVENT_LOG_PROVIDER } from '@kbn/actions-plugin/server/constants/event_log';
import { createRuleRunActions } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import {
  ACTIONS_CONNECTORS_SETTINGS_ID,
  type ActionsTaskProcessSettings,
} from '@kbn/actions-plugin/server/task_types/task_process_settings';
import type { RuleRunContribution } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import type { KibanaRequest, SecurityServiceStart } from '@kbn/core/server';
import { DataStreamClient } from '@kbn/data-streams';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import { kibanaPackageJson } from '@kbn/repo-info';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { registerRunFlusher } from '@kbn/task-manager-plugin/server/task_process/run_context';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { UsageReportingService } from '@kbn/usage-api-plugin/server/usage_reporting';
import type { UsageReportingConfig } from '@kbn/usage-api-plugin/server/usage_reporting';
import { SystemConnectorsMap } from '@kbn/workflows';
import {
  createEventChainContextStore,
  createServerStepRegistry,
} from '@kbn/workflows-extensions/server';
import type {
  WorkflowStepRunCheck,
  WorkflowStepsContribution,
  WorkflowStepsContributionContext,
  WorkflowStepsContributionServices,
} from '@kbn/workflows-extensions/server';
import {
  RULE_RUN_CONTRIBUTIONS_KEY,
  WORKFLOW_STEPS_CONTRIBUTIONS_KEY,
  WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID,
  WORKFLOWS_ENGINE_SETTINGS_ID,
  WORKFLOWS_USAGE_API_SETTINGS_ID,
} from './constants';
import { WorkflowRuntimeServices } from './workflow_runtime_services';
import type { WorkflowsExecutionEngineConfig } from '../config';
import { createWorkflowRuntime } from '../create_workflow_runtime';
import type { WorkflowRuntime } from '../create_workflow_runtime';
import { getWorkflowDataStreamDefinitions } from '../data_streams';
import { assertRunnableInProcessPreflight } from '../lib/assert_runnable_in_process';
import { createRetryingEsClient } from '../lib/create_retrying_es_client';
import type { WorkflowMeteringCloud } from '../metering';
import { WorkflowsMeteringService } from '../metering/metering_service';
import { createDataStreamDataClients } from '../repositories/data_access_layer/implementations/data_stream/data_stream_data_client_bundle';
import { createPlainIndexDataClients } from '../repositories/data_access_layer/implementations/plain_index/plain_index_data_client_bundle';
import { ExecutionIdentityContexts } from '../service_account_execution';
import { HitlLifecycleAuditRegistry } from '../step/wait_for_input_step/hitl_lifecycle_auditor';
import type { WorkflowsEngineTaskPluginStart } from '../task_plugin';
import type { WorkflowCoreStart, WorkflowDataStreamsAdapter } from '../workflow_core_services';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/** For a host without service accounts (the security plugin did not serve them): a workflow that needs one is declined. */
const noServiceAccounts = (): SecurityServiceStart['serviceAccounts'] =>
  ({
    isEnabled: () => false,
    registerWorkloadType: onlyInKibana('Registering a workload type'),
    bindWorkload: onlyInKibana('Binding a service account'),
    unbindWorkload: onlyInKibana('Unbinding a service account'),
    getWorkloadBinding: onlyInKibana('Reading a service account binding'),
    withScopedRequestForWorkload: onlyInKibana('Running as a service account'),
  } as unknown as SecurityServiceStart['serviceAccounts']);

/**
 * The workflow runtime a task process runs, built from the task host: what Kibana builds from Core
 * and the plugins, built from the host's services. Nothing is installed (indices, templates, data
 * streams): Kibana did that before it dispatched the run.
 */
export const createWorkflowRuntimeFromHost = async (
  taskHost: TaskHost
): Promise<{ runtime: WorkflowRuntime; stop: () => Promise<void> }> => {
  const host: TaskHost = {
    ...taskHost,
    // These services belong to one workflow execution; Core's hooks survive worker reuse.
    onRunEnd: (flusher) => {
      if (!registerRunFlusher(flusher)) taskHost.onRunEnd?.(flusher);
    },
  };
  const settings = host.settings ?? {};
  const config = settings[WORKFLOWS_ENGINE_SETTINGS_ID] as WorkflowsExecutionEngineConfig;
  const actionsConfig = settings.actions as ActionsConfig;
  const cloud = settings[WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID] as
    | (WorkflowMeteringCloud & { kibanaUrl?: string })
    | undefined;
  const { logger } = host;
  const { featureFlags, userProfile, taskManager, licensing, encryptedSavedObjects, eventLog } =
    host;
  if (!config)
    throw new Error('The task process was not given the settings of the workflows engine');
  if (!featureFlags) throw new Error('The workflows task module did not get feature flags');
  if (!userProfile) throw new Error('The task process host did not lend Core user profile service');
  if (!taskManager) throw new Error('The workflows task module did not get task scheduling');
  if (!licensing) throw new Error('The workflows task module did not get the license');
  if (!encryptedSavedObjects) {
    throw new Error('The workflows task module did not get encrypted saved objects');
  }
  if (!eventLog) throw new Error('The workflows task module did not get the event log');

  const stops: Array<() => void | Promise<void>> = [];
  const stopServices = async () => {
    const results = await Promise.allSettled(stops.map(async (cleanup) => cleanup()));
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Failed to stop workflow execution services');
  };
  const esClient = createRetryingEsClient(host.elasticsearch.asInternalUser, logger);

  // Data streams: clients over the shared definitions, nothing installed.
  const definitions = getWorkflowDataStreamDefinitions(config.storage);
  const dataStreams: WorkflowDataStreamsAdapter = {
    initializeClient: (async (name: string) => {
      const dataStream = definitions[name];
      if (!dataStream) throw new Error(`Unknown workflows data stream: ${name}`);
      return DataStreamClient.fromDefinition({
        dataStream,
        elasticsearchClient: host.elasticsearch.asInternalUser,
      });
    }) as WorkflowDataStreamsAdapter['initializeClient'],
  };

  // Execution storage: the clients of the indices or data streams Kibana installed.
  let dataClients: WorkflowRuntimeDataClients;
  if (config.storage.source === 'data_stream') {
    const clients = createDataStreamDataClients({ esClient, logger });
    await clients.init();
    stops.push(clients.stop);
    dataClients = clients;
  } else {
    dataClients = {
      createWorkflowDataClient: () =>
        createPlainIndexDataClients({ esClient, logger }).workflowExecutionsDataClient,
      createStepDataClient: () =>
        createPlainIndexDataClients({ esClient, logger }).stepExecutionsDataClient,
    };
  }

  const workflowsExtensions = createServerStepRegistry(logger);

  // Connectors: the actions of the process, with the connector types the plugins contribute.
  const connectorContributions = (host.contributions?.[RULE_RUN_CONTRIBUTIONS_KEY] ??
    []) as RuleRunContribution[];
  const { actionsPlugin, hasActionType, stop } = createRuleRunActions({
    logger: logger.get('plugins', 'actions'),
    config: actionsConfig,
    getSystemIdentity: () =>
      (host.plugins?.security as SecurityTaskPluginStart | undefined)?.authc.systemIdentity,
    license$: licensing.license$,
    elasticsearch: host.elasticsearch,
    savedObjects: host.savedObjects,
    getEncryptedSavedObjectsClient: encryptedSavedObjects.getClient,
    taskManager: taskManager as never,
    publicBaseUrl: host.server.publicBaseUrl,
    // Kibana's final connectors, not rebuilt from the config.
    inMemoryConnectors: (
      settings[ACTIONS_CONNECTORS_SETTINGS_ID] as ActionsTaskProcessSettings | undefined
    )?.inMemoryConnectors,
    usageCounter: host.usageCounters?.getUsageCounter(ACTIONS_FEATURE_ID),
    featureUsage: licensing.featureUsage,
    authorization: (host.plugins?.security as { authz?: never } | undefined)?.authz,
    executor: {
      security: host.security as SecurityServiceStart,
      eventLogger: eventLog.getLogger({
        event: { provider: ACTIONS_EVENT_LOG_PROVIDER },
      }) as IEventLogger,
      analyticsService: host.analytics as never,
      createInternalRepository: host.savedObjects.createInternalRepository,
    },
    registerConnectorTypes: (actions) => {
      const registries = { actions, alerting: { registerConnectorAdapter: () => {} } };
      connectorContributions.forEach((contribution) =>
        contribution.register?.(registries as never, {
          logger,
          isServerless: host.server.isServerless,
          kibanaVersion: host.server.version,
          publicBaseUrl: host.server.publicBaseUrl,
          settings,
          host,
          getService: <T extends object>(id: string): T => runServices.getService<T>(id),
        })
      );
    },
  });
  stops.push(stop);

  // Steps: the internal ones (registered with the registry), and what the plugins contribute, which
  // may use the actions and the runtime of the engine, read when a step runs.
  const runChecks: WorkflowStepRunCheck[] = [];
  const stepContributions = (host.contributions?.[WORKFLOW_STEPS_CONTRIBUTIONS_KEY] ??
    []) as WorkflowStepsContribution[];
  const engineReady = Promise.withResolvers<WorkflowRuntime['contract']>();
  // The registry may be unused, but registration failures must reject every service waiting for it.
  void engineReady.promise.catch(() => {});
  const runServices = new WorkflowRuntimeServices(stepContributions, () => context, {
    actions: actionsPlugin,
  });
  const services: WorkflowStepsContributionServices = {
    registerRunCompletion: runServices.registerRunCompletion,
    stepRegistry: workflowsExtensions,
    registerService: runServices.registerService,
    getService: runServices.getService,
    getExecutionEngine: async <T extends object>(): Promise<T> => (await engineReady.promise) as T,
    getUnsecuredActionsClient: actionsPlugin.getUnsecuredActionsClient,
    executionDataClients: dataClients,
    getActionsClientWithRequest: (request) => actionsPlugin.getActionsClientWithRequest(request),
    scheduleWorkflow: async (workflow, workflowContext, request) =>
      (await engineReady.promise).scheduleWorkflow(workflow as never, workflowContext, request),
    emitEvent: async (params) => (await engineReady.promise).triggerEvents.emitEvent(params),
  };
  const context: WorkflowStepsContributionContext = {
    host,
    logger,
    isServerless: host.server.isServerless,
    kibanaVersion: host.server.version,
    publicBaseUrl: host.server.publicBaseUrl,
    settings,
    registerRunCheck: (check) => runChecks.push(check),
    hasStepDefinition: (stepTypeId) => workflowsExtensions.hasStepDefinition(stepTypeId),
    services,
  };
  try {
    await Promise.all(
      stepContributions.map((contribution) => contribution.register(workflowsExtensions, context))
    );
  } catch (error) {
    engineReady.reject(error);
    await stopServices();
    throw error;
  }

  // Links are built from Kibana's own public base URL (Core's `publicBaseUrl` is where the process
  // reaches Kibana), and calls go to `kibanaUrl`.
  const { basePath } = host.http;
  const http: WorkflowCoreStart['http'] = {
    selfClient: host.http.selfClient,
    getServerInfo: host.http.getServerInfo,
    kibanaUrl: basePath.publicBaseUrl,
    basePath: {
      serverBasePath: basePath.serverBasePath,
      publicBaseUrl: host.server.publicBaseUrl,
      get: basePath.get.bind(basePath),
      prepend: basePath.prepend.bind(basePath),
      remove: basePath.remove.bind(basePath),
    },
  };

  const usageApiSettings = settings[WORKFLOWS_USAGE_API_SETTINGS_ID] as
    | { url?: string; tls?: UsageReportingConfig['tls'] }
    | null
    | undefined;
  let metering: WorkflowsMeteringService | undefined;
  if (usageApiSettings?.url) {
    metering = new WorkflowsMeteringService(
      new UsageReportingService({
        config: { enabled: true, url: usageApiSettings.url, tls: usageApiSettings.tls },
        kibanaVersion: kibanaPackageJson.version,
        logger: logger.get('usageApi', 'usageReporting'),
      }),
      logger.get('workflowsMetering')
    );
    const meteringService = metering;
    host.onRunEnd?.(() => meteringService.flush());
  }

  let runtime: WorkflowRuntime;
  try {
    runtime = createWorkflowRuntime({
      state: {
        identityContexts: new ExecutionIdentityContexts(),
        // HTTP steps and plugin helpers read this request-local symbol too.
        eventChainContext: createEventChainContextStore(),
        hitlLifecycle: new HitlLifecycleAuditRegistry(),
      },
      logger,
      config,
      elasticsearch: { client: host.elasticsearch },
      security: {
        authc: host.security.authc,
        audit: host.security.audit,
        // The engine plugin's own: the workload bindings are scoped to the plugin that registered the type.
        serviceAccounts:
          (host.plugins?.workflowsExecutionEngine as WorkflowsEngineTaskPluginStart | undefined)
            ?.serviceAccounts ?? noServiceAccounts(),
      },
      userProfile,
      http,
      analytics: host.analytics,
      dataStreams,
      featureFlags,
      // A run has one space: the one its request names.
      spaces: {
        getSpaceId: (request: KibanaRequest) =>
          (request as { spaceId?: string } | undefined)?.spaceId ?? 'default',
      } as never,
      actions: { getActionsClientWithRequest: actionsPlugin.getActionsClientWithRequest },
      taskManager: taskManager as never,
      workflowsExtensions,
      licensing: { getLicense: () => firstValueFrom(licensing.license$) as never },
      dataClients,
      // The process meters itself, with the Usage API connection Kibana sent (none when Kibana does
      // not meter), and finishes sending before it answers.
      metering,
      // `canRunAs` is the default: the process's security plugin serves the service accounts from the
      // same bindings and credentials as Kibana (`serviceAccounts.enabled` says whether it does).
      cloud,
      preflight: assertRunnableInProcessPreflight,
      checkStep: (step) => {
        for (const check of runChecks) {
          const reason = check(step);
          if (reason) return reason;
        }
        return undefined;
      },
      // A connector step (`ConnectorStepImpl`) is `<connector type>` or `<connector type>.<sub action>`,
      // where the connector type is an action type id without its dot (`webhook`, `slack`, `cases`).
      // `console` is answered by the step itself. The `http` step runs as the `.http` system connector.
      //
      // The engine runs a step as a connector when it names a `connector-id`, or when it is a system
      // connector (`http`). A step that does neither is a custom step, so one missing from the registry
      // (a plugin whose steps this process does not have, such as `cases.addAlerts`) is declined and
      // never mistaken for a connector whose type shares its prefix.
      isConnectorStepType: ({ type, config: stepConfig }) => {
        if (type === 'console') return true;
        const [base] = type.split('.');
        const knownConnector = hasActionType(`.${base}`) || hasActionType(base);
        if (!knownConnector) return false;
        return (
          typeof stepConfig['connector-id'] === 'string' || SystemConnectorsMap.has(`.${type}`)
        );
      },
    });
  } catch (error) {
    engineReady.reject(error);
    await stopServices();
    throw error;
  }
  engineReady.resolve(runtime.contract);

  return {
    runtime,
    stop: async () => {
      try {
        await runServices.complete();
      } finally {
        await stopServices();
      }
    },
  };
};

type WorkflowRuntimeDataClients = Parameters<typeof createWorkflowRuntime>[0]['dataClients'];
