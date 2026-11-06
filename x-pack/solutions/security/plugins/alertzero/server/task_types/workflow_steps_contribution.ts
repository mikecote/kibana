/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup } from '@kbn/core/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { ManagedWorkflowStateApi } from '@kbn/workflows/server/types';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createWorkflowsReadApi } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type { WorkflowAccessCore } from '@kbn/workflows-management-plugin/server/services/workflow_access_control';
import { ALERTZERO_TELEMETRY_EVENT_TYPES } from '../telemetry/event_types';
import { registerAlertZeroStepDefinitions, registerTriageStepDefinitions } from '../step_types';
import {
  ALERTZERO_TASK_PROCESS_SETTINGS_ID,
  type AlertZeroTaskProcessSettings,
} from './alertzero_task_process_settings';

/** The id the managed workflows of AlertZero are owned by. */
const ALERTZERO_PLUGIN_ID = 'alertzero';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

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
 * `alertzero.triage.loadAlerts` and `alertzero.reportWorkerOutcome`.
 *
 * Not registered (a workflow that uses one is declined and Kibana runs it):
 * - `hunt.packageReport`: reads the investigation conversation and its attachments with Agent
 *   Builder's conversations client, which needs registries that other plugins fill in `setup()`
 *   (agents, attachment types), and the hunt services (proposals, fleet agents).
 * - `alertzero.investigation.summarize`: reads the conversation and runs the agent execution loop.
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [ALERTZERO_TASK_PROCESS_SETTINGS_ID],
    // The events of the report step; the process ships them itself.
    analyticsEventTypes: ALERTZERO_TELEMETRY_EVENT_TYPES as never,
  },
  register: (registry, { host, logger, services, settings }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const alertZero = settings[ALERTZERO_TASK_PROCESS_SETTINGS_ID] as
      | AlertZeroTaskProcessSettings
      | undefined;
    // The plugin is disabled in Kibana, which then sends no settings: nothing to register, and a
    // workflow that uses one of its steps is declined for the missing step.
    if (!alertZero) return;

    const { elasticsearch, security, userProfile, taskManager, analytics, plugins } =
      host as TaskHost;
    const securityPlugin = plugins?.security as SecurityTaskPluginStart | undefined;
    if (!securityPlugin) throw new Error('The task process did not get the security plugin');
    if (!userProfile) {
      throw new Error('The task process host did not lend Core user profile service');
    }
    if (!taskManager) throw new Error('The workflows task module did not get task scheduling');

    const alertZeroLogger = logger.get('alertzero');
    const readApi = createWorkflowsReadApi({
      logger: alertZeroLogger,
      esClient: elasticsearch.asInternalUser,
      core: {
        security,
        userProfile,
        elasticsearch: { client: elasticsearch },
      } as unknown as WorkflowAccessCore,
      authz: securityPlugin.authz as never,
      workflowExecutionsDataClient:
        services.executionDataClients.createWorkflowDataClient() as never,
      stepExecutionsDataClient: services.executionDataClients.createStepDataClient() as never,
    });
    // What the owner-bound client of the plugin reads, over the same storage.
    const managedWorkflowState: ManagedWorkflowStateApi = {
      getInstalledWorkflowState: (workflowId, spaceId) =>
        readApi.getInstalledManagedWorkflowState(workflowId, spaceId, ALERTZERO_PLUGIN_ID),
      listInstalledWorkflowStates: onlyInKibana('Listing the installed managed workflows') as never,
    };

    registerTriageStepDefinitions({
      workflowsExtensions: registry,
      getTaskManager: () => taskManager,
    });
    registerAlertZeroStepDefinitions({
      workflowsExtensions: registry,
      analytics: analytics as unknown as AnalyticsServiceSetup,
      areServiceAccountsEnabled: () => alertZero.serviceAccountsEnabled,
      // As in Kibana, there is no managed workflows client unless the plugin started it.
      getManagedWorkflowState: async () =>
        alertZero.managedWorkflowsReady ? managedWorkflowState : undefined,
      getWorkflowsManagement: () => ({ getWorkflowExecution: readApi.getWorkflowExecution }),
      isTelemetryOptedIn: async () => alertZero.telemetryOptedIn,
      logger: alertZeroLogger.get('telemetry'),
    });
  },
};
