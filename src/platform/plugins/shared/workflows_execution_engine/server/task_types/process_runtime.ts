/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type { ActionsConfig } from '@kbn/actions-plugin/server/config';
import { EVENT_LOG_PROVIDER as ACTIONS_EVENT_LOG_PROVIDER } from '@kbn/actions-plugin/server/constants/event_log';
import { createRuleRunActions } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import type { RuleRunContribution } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import type { KibanaRequest, SecurityServiceStart } from '@kbn/core/server';
import { DataStreamClient } from '@kbn/data-streams';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import {
  RULE_RUN_CONTRIBUTIONS_KEY,
  WORKFLOW_STEPS_CONTRIBUTIONS_KEY,
  WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID,
  WORKFLOWS_ENGINE_SETTINGS_ID,
  WORKFLOWS_METERING_TELEMETRY_KIND,
} from './constants';
import type { WorkflowsExecutionEngineConfig } from '../config';
import { createWorkflowRuntime } from '../create_workflow_runtime';
import type { WorkflowRuntime } from '../create_workflow_runtime';
import { getWorkflowDataStreamDefinitions } from '../data_streams';
import { assertRunnableInProcessPreflight } from '../lib/assert_runnable_in_process';
import { createRetryingEsClient } from '../lib/create_retrying_es_client';
import type { WorkflowMeteringCloud } from '../metering';
import { createDataStreamDataClients } from '../repositories/data_access_layer/implementations/data_stream/data_stream_data_client_bundle';
import { createPlainIndexDataClients } from '../repositories/data_access_layer/implementations/plain_index/plain_index_data_client_bundle';
import type { WorkflowDataStreamsAdapter } from '../workflow_core_services';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/** Service accounts are not available in a task process: a workflow that needs one is declined. */
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
  host: TaskHost
): Promise<{ runtime: WorkflowRuntime; stop: () => void }> => {
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

  const stops: Array<() => void> = [];
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
    license$: licensing.license$,
    elasticsearch: host.elasticsearch,
    savedObjects: host.savedObjects,
    getEncryptedSavedObjectsClient: encryptedSavedObjects.getClient,
    taskManager: taskManager as never,
    publicBaseUrl: host.server.publicBaseUrl,
    executor: {
      security: host.security as SecurityServiceStart,
      eventLogger: eventLog.getLogger({
        event: { provider: ACTIONS_EVENT_LOG_PROVIDER },
      }) as IEventLogger,
      analyticsService: host.analytics as never,
      authorization: (host.plugins?.security as { authz?: never } | undefined)?.authz,
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
        })
      );
    },
  });
  stops.push(stop);

  // Steps: the internal ones (registered with the registry), and what the plugins contribute, which
  // may use the actions and the runtime of the engine, read when a step runs.
  const started: { runtime?: WorkflowRuntime } = {};
  const stepContributions = (host.contributions?.[WORKFLOW_STEPS_CONTRIBUTIONS_KEY] ??
    []) as WorkflowStepsContribution[];
  await Promise.all(
    stepContributions.map((contribution) =>
      contribution.register(workflowsExtensions, {
        host,
        logger,
        isServerless: host.server.isServerless,
        kibanaVersion: host.server.version,
        publicBaseUrl: host.server.publicBaseUrl,
        settings,
        services: {
          getActionsClientWithRequest: (request) =>
            actionsPlugin.getActionsClientWithRequest(request),
          emitEvent: (params) => {
            if (!started.runtime) {
              throw new Error('The workflows runtime is not ready to emit events');
            }
            return started.runtime.emitEvent(params);
          },
        },
      })
    )
  );

  const runtime = createWorkflowRuntime({
    logger,
    config,
    elasticsearch: { client: host.elasticsearch },
    security: {
      authc: host.security.authc,
      audit: host.security.audit,
      serviceAccounts:
        (host.security as Partial<SecurityServiceStart>).serviceAccounts ?? noServiceAccounts(),
    },
    userProfile,
    http: host.http,
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
    // A process cannot send to the usage API: Kibana does, from what the run returns.
    metering: {
      report: (record) => host.telemetry.report(WORKFLOWS_METERING_TELEMETRY_KIND, record),
    },
    cloud,
    preflight: assertRunnableInProcessPreflight,
    // A connector step (`ConnectorStepImpl`) is `<connector type>` or `<connector type>.<sub action>`,
    // where the connector type is an action type id without its dot (`webhook`, `slack`, `cases`).
    // `console` is answered by the step itself. The `http` step runs as the `.http` system connector.
    isConnectorStepType: (stepType) => {
      if (stepType === 'console') return true;
      const [base] = stepType.split('.');
      return hasActionType(`.${base}`) || hasActionType(base);
    },
  });

  started.runtime = runtime;

  return {
    runtime,
    stop: () => stops.forEach((fn) => fn()),
  };
};

type WorkflowRuntimeDataClients = Parameters<typeof createWorkflowRuntime>[0]['dataClients'];
