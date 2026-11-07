/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import type { ManagedWorkflowStateApi } from '@kbn/workflows/server/types';
import type {
  WorkflowStepsContribution,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import type { ProposalsPluginStart } from '@kbn/proposals-plugin/server';
import type { FleetWorkflowRunServices } from '@kbn/fleet-plugin/server/services/run_time/workflow_run_services';
import type { WorkflowExecutionReader } from '../step_types/report_worker_outcome/report_worker_outcome_step';
import { registerAlertZeroTelemetryEvents } from '../telemetry';
import { registerUiSettings } from '../ui_settings';
import { registerAlertZeroStepDefinitions, registerTriageStepDefinitions } from '../step_types';
import { getSummarizeInvestigationStepDefinition } from '../step_types/summarize_investigation';
import { createResolveSummaryConnectorId } from '../services/investigation_summary/resolve_summary_connector';
import { getPackageReportStepDefinition } from '../step_types/package_report';
import { makeIsContextEngineEnabled } from '../step_types/is_context_engine_enabled';
import { makeScopedResolveHostEnrollment } from '../services/fleet/resolve_host_enrollment';
import { ActionsService } from '../services/actions/actions_service';
import {
  WatchWorkflowsManagementClientImpl,
  type WatchWorkflowsManagementApi,
} from '../services/watches/watch_workflows_management_client';
import {
  ALERTZERO_TASK_PROCESS_SETTINGS_ID,
  type AlertZeroTaskProcessSettings,
} from './alertzero_task_process_settings';

/** The id the managed workflows of AlertZero are owned by. */
const ALERTZERO_PLUGIN_ID = 'alertzero';

/**
 * The AlertZero steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps are registered by the
 * functions `plugin.ts` calls: the triage steps over `taskManager.aggregate` of the host and the
 * Kibana API of the run, and `alertzero.reportWorkerOutcome` over the reads of the workflows
 * management plugin on the engine's storage, the analytics of the host (the process ships the
 * events itself) and what Kibana knew when it dispatched the run
 * (`settings.alertzero`: service accounts, the managed workflows client, the telemetry opt-in).
 *
 * Served in a process: `alertzero.triage.headroom`, `alertzero.triage.planSweep`,
 * `alertzero.triage.loadAlerts`, `alertzero.reportWorkerOutcome` and
 * `alertzero.investigation.summarize` (native conversations, agent execution and connector policy),
 * and `hunt.packageReport` (native conversations, proposals, action catalog and scoped Fleet enrollment).
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [ALERTZERO_TASK_PROCESS_SETTINGS_ID],
    registerUiSettings: (registry, settings) => {
      if (settings[ALERTZERO_TASK_PROCESS_SETTINGS_ID]) registerUiSettings(registry);
    },
    // The events of the report step; the process ships them itself.
    registerAnalyticsEventTypes: registerAlertZeroTelemetryEvents,
  },
  register: (registry, { host, logger, services, settings, registerRunCheck }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const alertZero = settings[ALERTZERO_TASK_PROCESS_SETTINGS_ID] as
      | AlertZeroTaskProcessSettings
      | undefined;
    // The plugin is disabled in Kibana, which then sends no settings: nothing to register, and a
    // workflow that uses one of its steps is declined for the missing step.
    if (!alertZero) return;

    const taskHost = host as TaskHost;
    const { taskManager, analytics } = taskHost;
    if (!taskManager) throw new Error('The workflows task module did not get task scheduling');

    const alertZeroLogger = logger.get('alertzero');
    let managedWorkflowState: Promise<ManagedWorkflowStateApi> | undefined;
    let actions: ActionsService | undefined;
    const getAgentBuilder = () => services.getService<AgentBuilderPluginStart>('agentBuilder');
    registry.registerStepDefinition(
      getSummarizeInvestigationStepDefinition({
        getConversationClient: (request) =>
          getAgentBuilder().conversations.getScopedClient({ request }),
        executeAgent: (params) => getAgentBuilder().execution.executeAgent(params),
        resolveConnectorId: createResolveSummaryConnectorId(
          () =>
            alertZero.searchInferenceEndpointsAvailable
              ? services.getService<SearchInferenceEndpointsPluginStart>('searchInferenceEndpoints')
              : undefined,
          alertZeroLogger
        ),
      })
    );
    registry.registerStepDefinition(
      getPackageReportStepDefinition({
        getActionsService: () => {
          if (!alertZero.actionsServiceAvailable)
            throw new Error(
              'Actions service is not available until the AlertZero plugin has started'
            );
          actions ??= new ActionsService(
            () =>
              new WatchWorkflowsManagementClientImpl(
                services.getService<WatchWorkflowsManagementApi>('workflows.management')
              ),
            alertZeroLogger
          );
          return actions;
        },
        getConversations: () => getAgentBuilder().conversations,
        getHuntServices: () => {
          if (!alertZero.huntServicesReady)
            throw new Error(
              'Hunt services is not available until the AlertZero plugin has started'
            );
          return services.getService<ProposalsPluginStart>('proposals');
        },
        isContextEngineEnabled: makeIsContextEngineEnabled(() => {
          if (!taskHost.uiSettings)
            throw new Error('Hunt packaging requires the native UI settings service');
          return { uiSettings: taskHost.uiSettings, savedObjects: taskHost.savedObjects };
        }),
        getResolveHostEnrollment: (spaceId, esClient) => async (hostName) => {
          const agentService = alertZero.fleetAgentServiceAvailable
            ? (
                await services
                  .getService<FleetWorkflowRunServices>('fleet.runServices')
                  .getServices()
              ).agentService
            : undefined;
          return makeScopedResolveHostEnrollment(() => agentService, alertZeroLogger)(
            spaceId,
            esClient
          )(hostName);
        },
        getInternalEsClient: () => taskHost.elasticsearch.asInternalUser,
        logger: alertZeroLogger,
      })
    );
    const agentBuilderSteps = new Set(['alertzero.investigation.summarize', 'hunt.packageReport']);
    registerRunCheck?.((step) =>
      agentBuilderSteps.has(step.type)
        ? services.getService<() => string | undefined>('agentBuilder.parity')()
        : undefined
    );

    registerTriageStepDefinitions({
      workflowsExtensions: registry,
      getTaskManager: () => taskManager,
    });
    registerAlertZeroStepDefinitions({
      workflowsExtensions: registry,
      analytics,
      areServiceAccountsEnabled: () => alertZero.serviceAccountsEnabled,
      // As in Kibana, there is no managed workflows client unless the plugin started it.
      getManagedWorkflowState: async () => {
        if (!alertZero.managedWorkflowsReady) return undefined;
        managedWorkflowState ??= services
          .getService<Pick<WorkflowsExtensionsServerPluginStart, 'initManagedWorkflowsClient'>>(
            'workflows.extensions'
          )
          .initManagedWorkflowsClient(ALERTZERO_PLUGIN_ID);
        return managedWorkflowState;
      },
      getWorkflowsManagement: () =>
        services.getService<WorkflowExecutionReader>('workflows.management'),
      isTelemetryOptedIn: async () => alertZero.telemetryOptedIn,
      logger: alertZeroLogger.get('telemetry'),
    });
  },
};
