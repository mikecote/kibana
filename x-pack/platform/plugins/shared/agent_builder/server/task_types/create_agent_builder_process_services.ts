/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { KibanaRequest } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { ElasticsearchServiceStart } from '@kbn/core-elasticsearch-server';
import type { HttpServiceStart } from '@kbn/core-http-server';
import type { SecurityServiceStart } from '@kbn/core-security-server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { PluginSetupContract as ActionsPluginSetup } from '@kbn/actions-plugin/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import { InferenceFeatureRegistry } from '@kbn/search-inference-endpoints/server/inference_feature_registry';
import { createSearchInferenceEndpointsStart } from '@kbn/search-inference-endpoints/server/create_search_inference_endpoints_start';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import { AGENTBUILDER_USAGE_DOMAIN } from '../telemetry/usage_counters';
import { AnalyticsService, TrackingService } from '../telemetry';
import { registerInferenceFeatures } from '../inference_features';
import { createAgentBuilderRunServices } from '../run_services/create_agent_builder_run_services';
import type { AgentBuilderRunServices } from '../run_services/create_agent_builder_run_services';
import { AGENT_BUILDER_RUN_SETTINGS_ID, toAgentBuilderConfig } from '../run_services/run_settings';
import type { AgentBuilderRunSettings } from '../run_services/run_settings';
import { createConversationEventBus } from '../workflows/triggers/conversation_event_bus';
import type { ConversationEventBus } from '../workflows/triggers/conversation_event_bus';
import { createAgentBuilderStartContract } from '../run_services/create_start_contract';
import type {
  AgentBuilderContribution,
  AgentBuilderContributionContext,
  AgentBuilderContributionServices,
} from './agent_builder_contribution';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

export interface AgentBuilderProcessServices extends AgentBuilderRunServices {
  conversationEventBus: ConversationEventBus;
  /** What stands for the spaces plugin: a run has one space, the one its request names. */
  spaces: SpacesPluginStart;
  /** The inference features this process knows (those agent builder registers). */
  inferenceFeatureIds: () => string[];
  /** `xpack.agentBuilder.deductive.register`: the global settings of that agent only exist in Kibana. */
  deductiveRegistered: boolean;
}

/**
 * Agent builder's services in a task process, built by the function the plugin builds them with, from
 * the host of the process: the same registries, filled by the `agent-builder` contributions of the
 * plugins that fill them in Kibana, and started with Core's own services. What cannot exist in a
 * process (the callbacks of an asynchronous execution) throws "only available in Kibana" when used.
 *
 * Nothing is installed: indices and templates are Kibana's, and the storage of agents, conversations
 * and attachments is the plugin's own, which creates its index when it first writes, as in Kibana.
 */
export const createAgentBuilderProcessServices = async ({
  host,
  logger,
  settings,
  contributions,
  context: baseContext,
  getActionsClientWithRequest,
  getWorkflowsManagement,
  emitEvent,
}: {
  host: TaskHost;
  logger: Logger;
  settings: Record<string, unknown>;
  contributions: AgentBuilderContribution[];
  context: Omit<AgentBuilderContributionContext, 'services'>;
  /** The actions client of a request, from the engine's runtime. */
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
  /** The workflows management API of the process (`createWorkflowsProcessManagementApi`). */
  getWorkflowsManagement: () => WorkflowsServerPluginSetup['management'];
  /** Emits a workflow trigger event through the engine's runtime. */
  emitEvent: AgentBuilderContributionServices['emitEvent'];
}): Promise<AgentBuilderProcessServices | undefined> => {
  const runSettings = settings[AGENT_BUILDER_RUN_SETTINGS_ID] as
    | AgentBuilderRunSettings
    | undefined;
  // Agent builder is disabled in Kibana: nothing registers with it, and no step reads it.
  if (!runSettings) return undefined;

  const { elasticsearch, savedObjects, uiSettings, licensing } = host;
  if (!uiSettings) throw new Error('The workflows task module did not get ui settings');
  if (!licensing) throw new Error('The workflows task module did not get the license');

  const config = toAgentBuilderConfig(runSettings.config);
  const workflowsManagement = getWorkflowsManagement();
  const core = { elasticsearch, savedObjects, uiSettings };

  // The inference services, as the inference workflows contribution builds them, with the features
  // agent builder registers and the recommended endpoints Kibana's poller had found.
  const inference = createInferenceTaskProcessServices({
    core,
    logger,
    getActionsClientWithRequest,
  });
  const features = new InferenceFeatureRegistry(logger.get('inferenceFeatures'));
  registerInferenceFeatures({ searchInferenceEndpoints: { features } as never });
  for (const [featureId, endpoints] of Object.entries(runSettings.recommendedEndpoints ?? {})) {
    if (features.get(featureId) && endpoints.length) {
      features.updateRecommendedEndpoints(featureId, endpoints);
    }
  }
  const searchInferenceEndpoints = createSearchInferenceEndpointsStart({
    core,
    inference,
    featureRegistry: features,
    logger: logger.get('searchInferenceEndpoints'),
  });

  const actionsStart = {
    getActionsClientWithRequest,
    getActionsConfigurationUtilities: onlyInKibana('The actions configuration'),
    getRelayClient: onlyInKibana('The relay client'),
  } as unknown as ActionsPluginStart;

  const getCoreStart = async () =>
    ({
      elasticsearch: { client: elasticsearch },
      savedObjects,
      uiSettings,
      http: { basePath: host.http.basePath },
    } as unknown as Awaited<ReturnType<AgentBuilderContributionServices['getCoreStart']>>);

  const usageCounter = host.usageCounters?.getUsageCounter(AGENTBUILDER_USAGE_DOMAIN);
  const trackingService = usageCounter
    ? new TrackingService(usageCounter as never, logger.get('telemetry'))
    : undefined;
  // The event types are declared by the contribution and registered with Core by the module.
  const analyticsService = new AnalyticsService(
    { reportEvent: host.analytics.reportEvent, registerEventType: () => {} } as never,
    logger.get('telemetry').get('analytics')
  );

  const run = createAgentBuilderRunServices({
    config,
    logger,
    // The hooks that run an agent's workflows and the workflow tool type read the management API as
    // far as a process serves it (reading and running saved workflows).
    workflowsManagement: { management: workflowsManagement } as WorkflowsServerPluginSetup,
    trackingService,
    analyticsService,
    actions: {
      getActionsConfigurationUtilities: onlyInKibana('The actions configuration'),
      getRelayClient: onlyInKibana('The relay client'),
    } as unknown as ActionsPluginSetup,
    getActionsStart: async () => actionsStart,
    getInferenceStart: async () => inference,
    getCoreStart,
    taskProcess: { registerSettings: () => {} },
  });

  // The start contract is built once the services are started, which is after the contributions
  // registered: what they read of it is read when a tool runs.
  // eslint-disable-next-line prefer-const
  let startContract: AgentBuilderPluginStart | undefined;
  const context: AgentBuilderContributionContext = {
    ...baseContext,
    services: {
      getCoreStart,
      getActionsStart: async () => actionsStart,
      getActionsClientWithRequest,
      getWorkflowsManagement: () => workflowsManagement,
      emitEvent,
      getAgentBuilderStart: () => {
        if (!startContract) throw new Error('Agent builder is not started in this process yet');
        return startContract;
      },
    },
  };
  for (const contribution of contributions) {
    await contribution.register(run.setupContract, context);
  }

  // A run has one space: the one its request names.
  const spaces = {
    spacesService: {
      getSpaceId: (request: KibanaRequest) =>
        (request as { spaceId?: string } | undefined)?.spaceId ?? DEFAULT_SPACE_ID,
      getActiveSpace: async (request: KibanaRequest) => ({
        id: (request as { spaceId?: string } | undefined)?.spaceId ?? DEFAULT_SPACE_ID,
        name: (request as { spaceId?: string } | undefined)?.spaceId ?? DEFAULT_SPACE_ID,
        disabledFeatures: [],
      }),
    },
  } as unknown as SpacesPluginStart;

  const conversationEventBus = createConversationEventBus();
  const startServices = run.serviceManager.startServices({
    logger: logger.get('services'),
    security: host.security as SecurityServiceStart,
    elasticsearch: { client: elasticsearch } as unknown as ElasticsearchServiceStart,
    http: {
      selfClient: host.http.selfClient,
      basePath: host.http.basePath,
      getServerInfo: host.http.getServerInfo,
    } as unknown as HttpServiceStart,
    inference,
    spaces,
    actions: actionsStart,
    uiSettings: uiSettings as never,
    savedObjects: savedObjects as never,
    featureFlags: host.featureFlags as never,
    dataStreams: undefined as never,
    taskManager: host.taskManager as never,
    securityPlugin: undefined,
    trackingService,
    analyticsService,
    searchInferenceEndpoints,
    licensing: {
      getLicense: () => firstValueFrom(licensing.license$),
    } as unknown as LicensingPluginStart,
    deploymentInfo: runSettings.deploymentInfo,
    deductiveRegister: config.deductive?.register ?? false,
    conversationEventBus,
  });
  startContract = createAgentBuilderStartContract({
    startServices,
    coreStart: {
      elasticsearch: { client: elasticsearch },
      security: host.security,
      savedObjects,
    } as never,
    spaces,
    inference,
    searchInferenceEndpoints,
    trackingService,
    logger,
  });

  return {
    ...run,
    conversationEventBus,
    spaces,
    inferenceFeatureIds: () => features.getAll().map(({ featureId }) => featureId),
    deductiveRegistered: config.deductive?.register ?? false,
  };
};
