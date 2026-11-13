/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleRunActionsStart } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import { firstValueFrom } from 'rxjs';
import type { KibanaRequest } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { PluginSetupContract as ActionsPluginSetup } from '@kbn/actions-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import {
  createTaskProcessInferenceFeatureRegistry,
  INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID,
  type InferenceFeaturesTaskProcessSettings,
} from '@kbn/search-inference-endpoints/server/task_process_settings';
import { createSearchInferenceEndpointsStart } from '@kbn/search-inference-endpoints/server/create_search_inference_endpoints_start';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createSmlService } from '@kbn/agent-builder-sml-plugin/server/services/sml/sml_service';
import { createSmlStartContract } from '@kbn/agent-builder-sml-plugin/server/start_contract';
import type { AgentBuilderSmlPluginStart } from '@kbn/agent-builder-sml-plugin/server';
import type { SmlTypeDefinition } from '@kbn/agent-builder-sml-plugin/server';
import type { AuthorizationServiceSetup } from '@kbn/security-plugin-types-server';
import type {
  AgentBuilderContributionStart,
  AgentBuilderPluginStart,
} from '@kbn/agent-builder-server';
import { AGENTBUILDER_USAGE_DOMAIN } from '../telemetry/usage_counters';
import { AnalyticsService, TrackingService } from '../telemetry';
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

export interface AgentBuilderProcessServices extends AgentBuilderRunServices {
  start: AgentBuilderPluginStart;
  conversationEventBus: ConversationEventBus;
  /** The authorized spaces service of this execution. */
  spaces: SpacesPluginStart;
  searchInferenceEndpoints: ReturnType<typeof createSearchInferenceEndpointsStart>;
  /** The inference features sent by Kibana for this execution. */
  inferenceFeatureIds: () => string[];
  /** `xpack.agentBuilder.deductive.register`: the global settings of that agent only exist in Kibana. */
  deductiveRegistered: boolean;
}

/**
 * Agent builder's services in a task process, built by the function the plugin builds them with, from
 * the host of the process: the same registries, filled by the `agent-builder` contributions of the
 * plugins that fill them in Kibana, and started with Core's own services. The shared actions runtime
 * supplies asynchronous callback delivery.
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
  actions,
  spaces,
  getService,
  getWorkflowsManagement,
  emitEvent,
  registerRunCompletion,
}: {
  host: TaskHost;
  logger: Logger;
  settings: Record<string, unknown>;
  contributions: AgentBuilderContribution[];
  context: Omit<AgentBuilderContributionContext, 'services' | 'registerSmlType'>;
  /** The actions client of a request, from the engine's runtime. */
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
  actions: Pick<ActionsPluginSetup, 'getActionsConfigurationUtilities' | 'getRelayClient'>;
  spaces: SpacesPluginStart;
  getService: AgentBuilderContributionServices['getService'];
  /** The workflows management API of the process (`createWorkflowsProcessManagementApi`). */
  getWorkflowsManagement: () => WorkflowsServerPluginSetup['management'];
  /** Emits a workflow trigger event through the engine's runtime. */
  emitEvent: AgentBuilderContributionServices['emitEvent'];
  registerRunCompletion: AgentBuilderContributionServices['registerRunCompletion'];
}): Promise<AgentBuilderProcessServices | undefined> => {
  const runSettings = settings[AGENT_BUILDER_RUN_SETTINGS_ID] as
    | AgentBuilderRunSettings
    | undefined;
  // Agent builder is disabled in Kibana: nothing registers with it, and no step reads it.
  if (!runSettings) return undefined;

  const { elasticsearch, savedObjects, uiSettings, licensing, featureFlags } = host;
  if (!uiSettings) throw new Error('The workflows task module did not get ui settings');
  if (!licensing) throw new Error('The workflows task module did not get the license');
  if (!featureFlags) throw new Error('Native Agent Builder execution requires feature flags');

  const taskManager = host.taskManager;
  if (!taskManager) throw new Error('Native Agent Builder execution requires Task Manager');

  const config = toAgentBuilderConfig(runSettings.config);
  const workflowsManagement = getWorkflowsManagement();
  const core = { elasticsearch, savedObjects, uiSettings };

  // Both agents and AI workflow steps resolve features against the complete dispatch snapshot.
  const inference = createInferenceTaskProcessServices({
    core,
    logger,
    getActionsClientWithRequest,
  });
  const features = createTaskProcessInferenceFeatureRegistry(
    settings[INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID] as
      | InferenceFeaturesTaskProcessSettings
      | undefined,
    logger.get('inferenceFeatures')
  );
  const searchInferenceEndpoints = createSearchInferenceEndpointsStart({
    core,
    inference,
    featureRegistry: features,
    logger: logger.get('searchInferenceEndpoints'),
  });

  const actionsStart = getService<RuleRunActionsStart>('actions');

  const getCoreStart: AgentBuilderContributionServices['getCoreStart'] = async () => ({
    elasticsearch: { client: elasticsearch },
    savedObjects,
    uiSettings,
    http: host.http,
    security: host.security,
    userProfile: host.userProfile,
    featureFlags: host.featureFlags,
    analytics: host.analytics,
    executionContext: host.executionContext,
  });

  const usageCounter = host.usageCounters?.getUsageCounter(AGENTBUILDER_USAGE_DOMAIN);
  const trackingService = usageCounter
    ? new TrackingService(usageCounter, logger.get('telemetry'))
    : undefined;
  // The event types are declared by the contribution and registered with Core by the module.
  const analyticsService = new AnalyticsService(
    host.analytics,
    logger.get('telemetry').get('analytics')
  );

  // The SML plugin's registry and service: the types the contributions register are served as in Kibana,
  // and the SML tools read its start contract, built once the services are.
  const sml = createSmlService();
  const smlSetup = sml.setup({ logger: logger.get('sml') });
  // eslint-disable-next-line prefer-const
  let smlStart: AgentBuilderSmlPluginStart | undefined;

  const run = createAgentBuilderRunServices({
    config,
    getAgentBuilderSml: () => {
      if (!smlStart) throw new Error('SML is not started in this process yet');
      return smlStart;
    },
    logger,
    // The hooks that run an agent's workflows and the workflow tool type read the management API as
    // provided by the shared management runtime.
    workflowsManagement: { management: workflowsManagement } as WorkflowsServerPluginSetup,
    trackingService,
    analyticsService,
    actions: {
      getActionsConfigurationUtilities: actions.getActionsConfigurationUtilities,
      getRelayClient: actions.getRelayClient,
    },
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
    registerSmlType: (definition: SmlTypeDefinition) => {
      smlSetup.registerType(definition);
      run.registrations.recordSmlType(definition.id);
    },
    services: {
      getService,
      getCoreStart,
      getActionsStart: async () => actionsStart,
      getActionsClientWithRequest,
      getInferenceStart: () => inference,
      getWorkflowsManagement: () => workflowsManagement,
      emitEvent,
      registerRunCompletion,
      getAgentBuilderStart: () => {
        if (!startContract) throw new Error('Agent builder is not started in this process yet');
        return startContract;
      },
    },
  };
  for (const contribution of contributions) {
    await contribution.register(run.setupContract, context);
  }

  const conversationEventBus = createConversationEventBus();
  const startServices = run.serviceManager.startServices({
    logger: logger.get('services'),
    security: host.security,
    elasticsearch: { client: elasticsearch },
    http: {
      selfClient: host.http.selfClient,
      basePath: host.http.basePath,
      getServerInfo: host.http.getServerInfo,
    },
    inference,
    spaces,
    actions: actionsStart,
    uiSettings,
    savedObjects,
    featureFlags,
    taskManager,
    securityPlugin: undefined,
    trackingService,
    analyticsService,
    searchInferenceEndpoints,
    licensing: {
      getLicense: () => firstValueFrom(licensing.license$),
    },
    deploymentInfo: runSettings.deploymentInfo,
    deductiveRegister: config.deductive?.register ?? false,
    conversationEventBus,
  });
  // Without security Kibana's SML runs without permission checks too; with it, the privileges of the
  // request are checked as in Kibana.
  smlStart = createSmlStartContract({
    smlService: sml.start({
      logger: logger.get('sml'),
      securityAuthz: (host.plugins?.security as { authz?: AuthorizationServiceSetup } | undefined)
        ?.authz,
    }),
    elasticsearch: { client: elasticsearch },
    savedObjects,
    spaces,
    logger: logger.get('sml'),
  });
  workflowsManagement.setSmlClient(smlStart, logger.get('workflowsManagement'));
  startContract = createAgentBuilderStartContract({
    startServices,
    coreStart: {
      elasticsearch: { client: elasticsearch },
      security: host.security,
      savedObjects,
    },
    spaces,
    inference,
    searchInferenceEndpoints,
    trackingService,
    logger,
    onSkillRegistered: run.registrations.recordSkill,
  });

  // What plugins register after start, as the current set Kibana sent: skills through the start
  // contract, and the availability of the agents Kibana persisted (a process does not write them).
  const contributionStart: AgentBuilderContributionStart = {
    skills: { register: startContract.skills.register },
    agents: {
      ensure: async ({ agent, availability, hidden }) => {
        startServices.agents.setAgentAvailability({ agentId: agent.id, availability, hidden });
      },
    },
  };
  for (const contribution of contributions) {
    await contribution.registerAtStart?.(contributionStart, context);
  }

  return {
    ...run,
    start: startContract,
    conversationEventBus,
    spaces,
    inferenceFeatureIds: () => features.getAll().map(({ featureId }) => featureId),
    searchInferenceEndpoints,
    deductiveRegistered: config.deductive?.register ?? false,
  };
};
