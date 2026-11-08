/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { getNamespacedRuleDataAlias } from '@kbn/rule-registry-plugin/server';
import type {
  WorkflowsExtensionsServerPluginStart,
  WorkflowStepsContribution,
} from '@kbn/workflows-extensions/server';
import { AppClient } from '../client';
import { SecuritySolutionEventBus } from '../events/event_bus';
import { registerSecurityWorkflowEventBridge } from '../workflows/triggers/event_bridge';
import { createSecurityAlertsClientFactory } from '../lib/detection_engine/alerts/create_alerts_client';
import {
  SECURITY_ALERTS_SETTINGS_ID,
  type SecurityAlertsTaskProcessSettings,
} from './security_alerts_settings';
import { registerSecurityWorkflowSteps } from '../workflows/register_security_workflow_steps';

export interface SecurityWorkflowEvents {
  eventBus?: SecuritySolutionEventBus;
  flushEvents?: () => Promise<void>;
}

/**
 * The workflow steps and triggers of the plugin, in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 */
export const contribution: WorkflowStepsContribution = {
  declares: { settings: [SECURITY_ALERTS_SETTINGS_ID] },
  provides: {
    'securitySolution.events': ({ host: taskHost, settings, services, logger }) => {
      const host = taskHost as TaskHost;
      const snapshot = settings[SECURITY_ALERTS_SETTINGS_ID] as
        | SecurityAlertsTaskProcessSettings
        | undefined;
      if (!snapshot || !services || !host.onRunEnd)
        throw new Error(
          'Native Security events require their dispatch snapshot and lifecycle services'
        );
      if (!snapshot.workflowEventsAvailable) return { eventBus: undefined };
      const eventBus = new SecuritySolutionEventBus();
      const flushEvents = registerSecurityWorkflowEventBridge(
        eventBus,
        services.getService<WorkflowsExtensionsServerPluginStart>('workflows.extensions'),
        logger
      );
      services.registerRunCompletion(flushEvents);
      host.onRunEnd(async () => {
        eventBus.removeAllListeners();
      });
      return { eventBus, flushEvents };
    },
    'securitySolution.alerts': ({ host: taskHost, settings, services }) => {
      const host = taskHost as TaskHost;
      const snapshot = settings[SECURITY_ALERTS_SETTINGS_ID] as
        | SecurityAlertsTaskProcessSettings
        | undefined;
      const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
      if (!snapshot || !services || !security || !host.onRunEnd)
        throw new Error(
          'Native Security alerts require their dispatch settings, Security and run lifecycle services'
        );
      const spaces = services.getService<SpacesPluginStart>('spaces');
      const { eventBus } = services.getService<SecurityWorkflowEvents>('securitySolution.events');
      return createSecurityAlertsClientFactory({
        getEsClient: (request) => host.elasticsearch.asScoped(request).asCurrentUser,
        getSearchIndex: (request) =>
          snapshot.searchIndexName
            ? getNamespacedRuleDataAlias(
                snapshot.searchIndexName,
                spaces.spacesService.getSpaceId(request)
              )
            : undefined,
        getAppClient: (request) => {
          if (!snapshot.appClientInitialized)
            throw new Error('The dispatching Security alerts client is not initialized');
          return new AppClient(
            spaces.spacesService.getSpaceId(request),
            { signalsIndex: snapshot.signalsIndex },
            host.server.version,
            snapshot.kibanaBranch,
            snapshot.buildFlavor
          );
        },
        getAuditLogger: (request) => security.audit.asScoped(request),
        getSecurity: async () => security,
        eventBus,
      });
    },
  },
  register: (registry, { logger }) => {
    registerSecurityWorkflowSteps(registry, {
      threatIntelLogger: logger.get('securitySolution', 'threatIntel'),
    });
  },
};
