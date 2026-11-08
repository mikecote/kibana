/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { NIGHTSHIFT_ENABLED_FLAG } from '@kbn/nightshift-shared';
import { registerNightshiftWorkflowSteps } from '../workflows/register_workflow_steps';
import { registerInvestigationsWorkflowTriggers } from '../workflows/triggers/register_triggers';
import {
  NightshiftTelemetryClient,
  registerNightshiftTelemetryEvents,
  registerCortexTelemetryEvents,
} from '../telemetry';
import {
  nightshiftAutomationSavedObjectType,
  nightshiftAutomationBudgetSavedObjectType,
  nightshiftSecretsSavedObjectType,
  nightshiftCustomContextSavedObjectType,
  nightshiftSecretsEncryptionParams,
} from '../saved_objects';
import { createNightshiftProcessServices } from './create_nightshift_process_services';
import type { NightshiftProcessServices } from './create_nightshift_process_services';
import { NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID } from './nightshift_task_process_settings';
import type { NightshiftTaskProcessSettings } from './nightshift_task_process_settings';

/** Registers all Nightshift workflow steps with native stores, agents, quota enforcement and Sandbox. */
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID],
    featureFlags: { [NIGHTSHIFT_ENABLED_FLAG]: false },
    savedObjectTypes: [
      nightshiftAutomationSavedObjectType,
      nightshiftAutomationBudgetSavedObjectType,
      nightshiftSecretsSavedObjectType,
      nightshiftCustomContextSavedObjectType,
    ],
    encryptedSavedObjectTypes: [nightshiftSecretsEncryptionParams],
    registerAnalyticsEventTypes: (analytics) => {
      registerNightshiftTelemetryEvents(analytics);
      registerCortexTelemetryEvents(analytics);
    },
  },
  provides: {
    'nightshift.runtime': ({ host, settings, services, logger }) => {
      const snapshot = settings[NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] as
        | NightshiftTaskProcessSettings
        | undefined;
      if (!snapshot || !services)
        throw new Error('Native Nightshift requires its dispatch settings and workflow services');
      return createNightshiftProcessServices({
        host: host as TaskHost,
        settings: snapshot,
        dispatchSettings: settings,
        services,
        logger: logger.get('nightshift'),
        registerRunCompletion: services.registerRunCompletion,
      });
    },
  },
  register: (registry, { host: taskHost, logger, services, settings }) => {
    const snapshot = settings[NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] as
      | NightshiftTaskProcessSettings
      | undefined;
    if (!snapshot) return;
    if (!services) throw new Error('Native Nightshift requires workflow services');
    registerInvestigationsWorkflowTriggers(registry);
    if (!snapshot.workflowsManagementAvailable) return;
    const host = taskHost as TaskHost;
    if (!host.uiSettings) throw new Error('Native Nightshift requires scoped UI settings');
    const uiSettings = host.uiSettings;
    const getRuntime = (): NightshiftProcessServices =>
      services.getService<NightshiftProcessServices>('nightshift.runtime');
    registerNightshiftWorkflowSteps(registry, {
      getInference: () => getRuntime().getInference(),
      getSavedObjects: () => host.savedObjects,
      getUiSettings: () => uiSettings,
      getTelemetryConnectorId: () => snapshot.telemetryConnectorId,
      isDecisionTreesEnabled: () => snapshot.decisionTreesEnabled,
      isCortexEnabled: () => snapshot.cortexEnabled === true,
      isMemoryEnabled: () => snapshot.memoryEnabled === true,
      logger: logger.get('nightshift'),
      getInvestigationsClient: (request, spaceId) =>
        getRuntime().getInvestigationsClient(request, spaceId),
      getAutomationsSoClient: (request, spaceId) =>
        getRuntime().getAutomationsSoClient(request, spaceId),
      getAgentBuilder: () => getRuntime().getAgentBuilder(),
      getAgentAvailability: () => getRuntime().getAgentAvailability(),
      investigationLocator: {
        getRedirectUrl: (params, options) =>
          getRuntime().investigationLocator.getRedirectUrl(params, options),
      },
      getActions: () => getRuntime().getActions(),
      getRoutingClient: (request, spaceId, conversationId, investigationId) =>
        getRuntime().getRoutingClient(request, spaceId, conversationId, investigationId),
      getTriggerEmitter: (request) => getRuntime().getTriggerEmitter(request),
      getSandboxStart: () => getRuntime().getSandboxStart(),
      analytics: host.analytics,
      telemetry: new NightshiftTelemetryClient(
        host.analytics,
        logger.get('nightshift', 'telemetry')
      ),
    });
  },
};
