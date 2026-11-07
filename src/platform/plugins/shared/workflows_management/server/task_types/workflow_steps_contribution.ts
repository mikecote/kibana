/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowsExecutionEnginePluginStart } from '@kbn/workflows-execution-engine/server';
import type {
  WorkflowsExtensionsServerPluginStart,
  WorkflowStepsContribution,
} from '@kbn/workflows-extensions/server';
import type { WorkflowsProcessServices } from '../api/workflows_process_management_api';
import { createWorkflowsProcessServices } from '../api/workflows_process_management_api';
import type { WorkflowManagementStartServices } from '../runtime/dependencies';
import { registerConnectorEventTriggers } from '../triggers/register_connector_event_triggers';

/**
 * The connector event triggers, built from the connector specs, in the task process of the workflow
 * task types. Whether inbound events are enabled is read from the config of the actions plugin, as
 * Kibana reads it. Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 */
export const contribution: WorkflowStepsContribution = {
  declares: { settings: ['workflowsManagementRuntime'] },
  provides: {
    'workflows.runtime': ({ host: taskHost, services, settings, logger, kibanaVersion }) => {
      const host = taskHost as TaskHost;
      const snapshot = settings.workflowsManagementRuntime as
        | {
            available: boolean;
            managedWorkflowPluginIds: string[];
          }
        | undefined;
      if (
        !snapshot ||
        !services ||
        !host.userProfile ||
        !host.featureFlags ||
        !host.licensing ||
        !host.taskManager ||
        !host.onRunEnd
      ) {
        throw new Error(
          'The workflow management runtime did not receive its required services and settings'
        );
      }
      const { userProfile, featureFlags, licensing, taskManager, onRunEnd } = host;
      return createWorkflowsProcessServices({
        logger: logger.get('workflowsManagement'),
        kibanaVersion,
        isWorkflowsAvailable: snapshot.available,
        onRunEnd,
        getSpaceId: (request) =>
          request.spaceId ??
          decodeURIComponent(
            host.http.basePath.get(request).split('/s/')[1]?.split('/')[0] ?? 'default'
          ),
        waitUntilReady: async (signal) => {
          signal.throwIfAborted();
          await host.elasticsearch.asInternalUser.ping({}, { signal });
          return { ready: true };
        },
        getStartServices: async (): Promise<WorkflowManagementStartServices> => ({
          core: {
            elasticsearch: { client: host.elasticsearch },
            security: host.security,
            userProfile,
            featureFlags,
          },
          actions: {
            getUnsecuredActionsClient:
              services.getUnsecuredActionsClient as WorkflowManagementStartServices['actions']['getUnsecuredActionsClient'],
            getActionsClientWithRequest:
              services.getActionsClientWithRequest as WorkflowManagementStartServices['actions']['getActionsClientWithRequest'],
          },
          taskManager,
          workflowsExecutionEngine:
            await services.getExecutionEngine<WorkflowsExecutionEnginePluginStart>(),
          workflowsExtensions: {
            // Definitions remain live until every contribution has registered.
            ...services.stepRegistry,
            getManagedWorkflowPluginIds: () => snapshot.managedWorkflowPluginIds,
          },
          licensing: { getLicense: () => firstValueFrom(licensing.license$) },
          security: host.plugins?.security as SecurityTaskPluginStart | undefined,
        }),
      });
    },
    'workflows.management': ({ services }) => {
      if (!services) throw new Error('Workflow execution services are required');
      return services.getService<WorkflowsProcessServices>('workflows.runtime').management;
    },
    'workflows.extensions': ({
      services,
      host: taskHost,
      settings,
    }): WorkflowsExtensionsServerPluginStart => {
      if (!services) throw new Error('Workflow execution services are required');
      const runtime = services.getService<WorkflowsProcessServices>('workflows.runtime');
      const snapshot = settings.workflowsManagementRuntime as {
        managedWorkflowPluginIds: string[];
      };
      const host = taskHost as TaskHost;
      return {
        ...services.stepRegistry,
        getClient: runtime.getClient,
        initManagedWorkflowsClient: runtime.initManagedWorkflowsClient,
        getManagedWorkflowPluginIds: () => [...snapshot.managedWorkflowPluginIds],
        getTaskProcessSettings: () =>
          Object.fromEntries(Object.entries(settings).map(([id, value]) => [id, () => value])),
        getTaskProcessParity: () =>
          Object.fromEntries((host.parity ?? []).map(({ kind, ids }) => [kind, () => [...ids]])),
      };
    },
  },
  register: (registry, { settings }) => {
    const actions = settings.actions as { inboundEvents?: { enabled?: boolean } } | undefined;
    registerConnectorEventTriggers({
      inboundEventsEnabled: actions?.inboundEvents?.enabled === true,
      registerTriggerDefinition: (definition) => registry.registerTriggerDefinition(definition),
    });
  },
};
