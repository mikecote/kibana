/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger, SavedObjectsClientContract } from '@kbn/core/server';
import { SECURITY_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { AgentBuilderPluginStart, AvailabilityConfig } from '@kbn/agent-builder-server';
import { getAgenticInvestigationsTaskProcessServices } from '@kbn/agentic-investigations-plugin/server';
import type { AgenticInvestigationsTaskProcessServices } from '@kbn/agentic-investigations-plugin/server';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SandboxTaskProcessRuntime, SandboxPluginStart } from '@kbn/sandbox-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { createServerUrlService } from '@kbn/share-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type {
  WorkflowsExtensionsServerPluginStart,
  WorkflowStepsContributionServices,
} from '@kbn/workflows-extensions/server';
import { InvestigationLocatorDefinition } from '../../common/locators';
import type { InvestigationLocator } from '../../common/locators';
import { NightshiftInvestigationsClient } from '../client/investigations_client';
import { createInvestigationAvailability } from '../create_investigation_availability';
import { createCustomContextClient } from '../custom_context';
import {
  isInvestigationInfrastructureAvailable,
  isInvestigationRunAvailable,
} from '../is_investigation_available';
import { notificationRoutingAttachment } from '../lib/notifications/notification_routing';
import { NotificationRoutingClient } from '../lib/notifications/notification_routing_client';
import type { InvestigationNotificationDeps } from '../lib/notifications/send_investigation_notifications';
import { createSandboxSecretsClient } from '../sandbox_secrets';
import {
  NIGHTSHIFT_AUTOMATION_SO_TYPE,
  NIGHTSHIFT_AUTOMATION_BUDGET_SO_TYPE,
} from '../saved_objects';
import type { NightshiftInvestigationQuotaService, GetTriggerEmitter } from '../types';
import { createTriggerEmitter } from '../workflows/triggers/emit';
import type { NightshiftTaskProcessSettings } from './nightshift_task_process_settings';

export interface NightshiftProcessServices {
  getAgentBuilder: () => AgentBuilderPluginStart | undefined;
  getAgentAvailability: () => AvailabilityConfig;
  getInference: () => InferenceServerStart | undefined;
  getInvestigationsClient: (
    request: KibanaRequest,
    spaceId?: string
  ) => NightshiftInvestigationsClient;
  getRoutingClient: InvestigationNotificationDeps['getRoutingClient'];
  routingService: ReturnType<typeof notificationRoutingAttachment.createService>;
  customContext: ReturnType<typeof createCustomContextClient>;
  sandboxSecrets: ReturnType<typeof createSandboxSecretsClient>;
  getSandboxStart: () => SandboxPluginStart | undefined;
  getActions: () =>
    | Pick<
        ActionsPluginStart,
        | 'getActionsClientWithRequest'
        | 'getActionsAuthorizationWithRequest'
        | 'getActionsClientWithRequestInSpace'
        | 'inMemoryConnectors'
      >
    | undefined;
  getAutomationsSoClient: (request: KibanaRequest, spaceId: string) => SavedObjectsClientContract;
  investigationLocator: InvestigationLocator;
  getTriggerEmitter: GetTriggerEmitter;
  flushEvents: () => Promise<void>;
}

/** Composes native Nightshift stores, availability, authorization and routing for one process run. */
export const createNightshiftProcessServices = ({
  host,
  settings,
  dispatchSettings,
  services,
  logger,
  registerRunCompletion,
}: {
  host: TaskHost;
  settings: NightshiftTaskProcessSettings;
  dispatchSettings: NonNullable<TaskHost['settings']>;
  services: Pick<WorkflowStepsContributionServices, 'getService' | 'getActionsClientWithRequest'>;
  logger: Logger;
  registerRunCompletion?: WorkflowStepsContributionServices['registerRunCompletion'];
}): NightshiftProcessServices => {
  const { featureFlags, uiSettings, savedObjects } = host;
  if (!featureFlags || !uiSettings)
    throw new Error('Native Nightshift requires Core feature flags and scoped UI settings');
  const spaces = settings.spacesEnabled
    ? services.getService<SpacesPluginStart>('spaces')
    : undefined;
  const security = settings.securityAvailable
    ? (host.plugins?.security as SecurityTaskPluginStart | undefined)
    : undefined;
  if (settings.securityAvailable && !security)
    throw new Error('Native Nightshift requires the dispatching Security services');
  const getAgentBuilder = (): AgentBuilderPluginStart | undefined =>
    settings.agentBuilderAvailable
      ? services.getService<AgentBuilderPluginStart>('agentBuilder')
      : undefined;
  const getWorkflowsManagement = (): WorkflowsServerPluginSetup['management'] =>
    services.getService<WorkflowsServerPluginSetup['management']>('workflows.management');
  let agentic: AgenticInvestigationsTaskProcessServices | undefined;
  const getAgentic = (): AgenticInvestigationsTaskProcessServices | undefined => {
    if (!settings.agenticInvestigationsAvailable) return undefined;
    agentic ??= getAgenticInvestigationsTaskProcessServices({
      host,
      settings: dispatchSettings,
      logger,
      services: {
        getService: services.getService,
        getWorkflowsManagement,
        getAgentBuilderStart: () => {
          const agentBuilder = getAgentBuilder();
          if (!agentBuilder) throw new Error('Native investigations require Agent Builder');
          return agentBuilder;
        },
      },
    });
    return agentic;
  };
  let inference: InferenceServerStart | undefined;
  const getInference = (): InferenceServerStart | undefined =>
    settings.inferenceAvailable
      ? (inference ??= createInferenceTaskProcessServices({
          core: { elasticsearch: host.elasticsearch, savedObjects, uiSettings },
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        }))
      : undefined;
  const availabilityDeps = () => ({
    featureFlags,
    agentBuilder: getAgentBuilder(),
    agenticInvestigations: getAgentic(),
    proposals: settings.proposalsAvailable ? getAgentic()?.getProposals() : undefined,
    inference: getInference(),
    spaces,
    logger,
    workflowsExtensions:
      services.getService<WorkflowsExtensionsServerPluginStart>('workflows.extensions'),
    workflowsManagement: settings.workflowsManagementAvailable
      ? { management: getWorkflowsManagement() }
      : undefined,
  });
  const agentAvailability = createInvestigationAvailability({ getDeps: availabilityDeps });
  const getInvestigationsClient = (
    request: KibanaRequest,
    spaceId?: string
  ): NightshiftInvestigationsClient => {
    const resolvedSpaceId = spaceId ?? spaces?.spacesService.getSpaceId(request) ?? 'default';
    return new NightshiftInvestigationsClient({
      request,
      logger,
      spaces,
      spaceIdOverride: spaceId,
      workflowsManagement: settings.workflowsManagementAvailable
        ? { management: getWorkflowsManagement() }
        : undefined,
      agentBuilder: getAgentBuilder(),
      agenticInvestigations: getAgentic(),
      agentAvailability,
      investigationQuotaCallback: settings.hasInvestigationQuotaCallback
        ? services.getService<NightshiftInvestigationQuotaService>('nightshift.investigationQuota')
            .consume
        : undefined,
      inference: getInference(),
      savedObjects,
      uiSettings,
      isAvailable: (connectorId) =>
        isInvestigationRunAvailable({
          ...availabilityDeps(),
          request,
          spaceId: resolvedSpaceId,
          connectorId,
        }),
      isInfrastructureAvailable: () =>
        isInvestigationInfrastructureAvailable({
          ...availabilityDeps(),
          request,
          spaceId: resolvedSpaceId,
        }),
    });
  };
  const routingService = notificationRoutingAttachment.createService({
    esClient: host.elasticsearch.asInternalUser,
    logger,
  });
  const getRoutingClient: InvestigationNotificationDeps['getRoutingClient'] = async (
    request,
    spaceId,
    conversationId,
    investigationId
  ) => {
    const agentBuilder = getAgentBuilder();
    if (!agentBuilder) throw new Error('Agent Builder is not available');
    if (request.spaceId !== spaceId)
      throw new Error('Notification request and execution spaces do not match');
    const [attachments, conversations] = await Promise.all([
      agentBuilder.attachments.getScopedClient({ request }),
      agentBuilder.conversations.getScopedClient({ request }),
    ]);
    return new NotificationRoutingClient({
      service: routingService,
      attachments,
      conversations,
      spaceId,
      conversationId,
      investigationId,
    });
  };
  const urlService = createServerUrlService({
    baseUrl: host.server.publicBaseUrl || host.http.basePath.serverBasePath,
    version: host.server.version,
  });
  const customContext = createCustomContextClient({
    getDeps: () => ({
      featureFlags,
      savedObjects,
      security: host.security,
      securityPlugin: security,
      spaces,
    }),
  });
  const sandboxSecrets = createSandboxSecretsClient({
    getDeps: () => ({
      featureFlags,
      savedObjects,
      encryptedSavedObjects: host.encryptedSavedObjects,
      security,
      spaces,
    }),
    canEncrypt: settings.canEncrypt === true,
    logger,
  });
  const pendingEvents = new Set<Promise<void>>();
  const flushEvents = async (): Promise<void> => {
    while (pendingEvents.size) await Promise.allSettled([...pendingEvents]);
  };
  if (registerRunCompletion) registerRunCompletion(flushEvents);
  else {
    if (!host.onRunEnd) throw new Error('Native Nightshift requires event completion tracking');
    host.onRunEnd(flushEvents);
  }
  const getTriggerEmitter: GetTriggerEmitter = (request) =>
    createTriggerEmitter({
      request,
      logger,
      workflowsExtensions:
        services.getService<WorkflowsExtensionsServerPluginStart>('workflows.extensions'),
      onEmission: (emission) => {
        pendingEvents.add(emission);
        const forget = () => {
          pendingEvents.delete(emission);
        };
        void emission.then(forget, forget);
      },
    });
  return {
    getTriggerEmitter,
    flushEvents,
    getAgentBuilder,
    getAgentAvailability: () => agentAvailability,
    getInference,
    getInvestigationsClient,
    getRoutingClient,
    routingService,
    customContext,
    sandboxSecrets,
    getSandboxStart: () =>
      services.getService<SandboxTaskProcessRuntime>('sandbox.runtime').sandbox,
    getActions: (): ReturnType<NightshiftProcessServices['getActions']> =>
      settings.actionsAvailable ? services.getService('actions') : undefined,
    getAutomationsSoClient: (request: KibanaRequest, spaceId: string) =>
      savedObjects
        .getScopedClient(request, {
          excludedExtensions: [SECURITY_EXTENSION_ID],
          includedHiddenTypes: [
            NIGHTSHIFT_AUTOMATION_SO_TYPE,
            NIGHTSHIFT_AUTOMATION_BUDGET_SO_TYPE,
          ],
        })
        .asScopedToNamespace(spaceId),
    investigationLocator: urlService.locators.create(new InvestigationLocatorDefinition()),
  };
};
