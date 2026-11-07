/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { ManagedWorkflowStateApi } from '@kbn/workflows/server/types';
import type {
  WorkflowStepsContribution,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import type { WorkflowExecutionReader } from '../step_types/report_worker_outcome/report_worker_outcome_step';
import { registerAlertZeroTelemetryEvents } from '../telemetry';
import { registerUiSettings } from '../ui_settings';
import { registerAlertZeroStepDefinitions, registerTriageStepDefinitions } from '../step_types';
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
 * `alertzero.triage.loadAlerts` and `alertzero.reportWorkerOutcome`.
 *
 * Not registered yet (a workflow that uses one fails for the missing capability):
 * - `hunt.packageReport`: reads the investigation conversation and its attachments with Agent
 *   Builder's conversations client, which needs registries that other plugins fill in `setup()`
 *   (agents, attachment types), and the hunt services (proposals, fleet agents).
 * - `alertzero.investigation.summarize`: reads the conversation and runs the agent execution loop.
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
  register: (registry, { host, logger, services, settings }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const alertZero = settings[ALERTZERO_TASK_PROCESS_SETTINGS_ID] as
      | AlertZeroTaskProcessSettings
      | undefined;
    // The plugin is disabled in Kibana, which then sends no settings: nothing to register, and a
    // workflow that uses one of its steps is declined for the missing step.
    if (!alertZero) return;

    const { taskManager, analytics } = host as TaskHost;
    if (!taskManager) throw new Error('The workflows task module did not get task scheduling');

    const alertZeroLogger = logger.get('alertzero');
    let managedWorkflowState: Promise<ManagedWorkflowStateApi> | undefined;

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
