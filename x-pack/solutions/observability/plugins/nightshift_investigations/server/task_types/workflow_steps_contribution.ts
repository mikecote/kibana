/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerNightshiftProcessSteps } from '../workflows/register_process_steps';
import { registerInvestigationsWorkflowTriggers } from '../workflows/triggers/register_triggers';
import {
  NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID,
  type NightshiftTaskProcessSettings,
} from './nightshift_task_process_settings';

/**
 * The Nightshift investigations steps and triggers in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps are
 * registered by the function `plugin.ts` calls (`registerNightshiftProcessSteps`), with the inference
 * services built from the host (the ones Kibana builds), the host's saved objects and ui settings
 * (the gen AI settings come from the inference workflows contribution), and what Kibana sent
 * (`settings.nightshiftInvestigations`).
 *
 * Served in a process: `nightshift.resolveModel`, `nightshift.composeHydrateNotifications`,
 * `nightshift.decisionTreePrepare` and the investigation triggers.
 *
 * Not registered (a workflow that uses one is declined and Kibana runs it), see
 * `KIBANA_ONLY_NIGHTSHIFT_STEPS` for each reason: the steps that need Agent Builder's agents,
 * conversations, attachments or execution (`triggerInvestigation`, `ensureInvestigationAgent`,
 * `sendNotifications`, `handleInvestigationFailure`, `renderSlackMessage`, `cortexOptimize`,
 * `memoryOptimize`, `decisionTreeReinforce`) and the ones that need the sandbox plugin
 * (`obtainSandbox`, `cortexHydrate`, `memoryMaterializeToSandbox`, `decisionTreeHydrate`).
 */
export const contribution: WorkflowStepsContribution = {
  declares: { settings: [NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] },
  register: (registry, { host, logger, services, settings }) => {
    const nightshift = settings[NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] as
      | NightshiftTaskProcessSettings
      | undefined;
    // The plugin is disabled in Kibana, which then sends no settings: nothing to register, and a
    // workflow that uses one of its steps or triggers is declined for the missing type.
    if (!nightshift) return;
    if (!services) throw new Error('The workflows task process did not give the engine services');

    // Kibana registers the triggers with the workflows extensions, and the steps only with the
    // workflows management plugin too.
    registerInvestigationsWorkflowTriggers(registry);
    if (!nightshift.workflowsManagementAvailable) return;

    const { elasticsearch, savedObjects, uiSettings } = host as TaskHost;
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    let inference: InferenceServerStart | undefined;
    registerNightshiftProcessSteps(registry, {
      getInference: () =>
        (inference ??= createInferenceTaskProcessServices({
          core: { elasticsearch, savedObjects, uiSettings },
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        })),
      getSavedObjects: () => savedObjects as never,
      getUiSettings: () => uiSettings as never,
      getTelemetryConnectorId: () => nightshift.telemetryConnectorId,
      isDecisionTreesEnabled: () => nightshift.decisionTreesEnabled,
      logger: logger.get('nightshift'),
    });
  },
};
