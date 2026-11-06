/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { UiSettingsServiceSetup } from '@kbn/core-ui-settings-server';
import type { Logger } from '@kbn/logging';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { UsageApiSetup } from '@kbn/usage-api-plugin/server';
import type {
  PluginSetupContract as ActionsPluginSetup,
  PluginStartContract as ActionsPluginStart,
} from '@kbn/actions-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { AgentBuilderSmlPluginStart } from '@kbn/agent-builder-sml-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type {
  AgentBuilderPluginSetup,
  ConversationUpdatedOptIn,
  TaskProcessSetup,
} from '@kbn/agent-builder-server';
import type { AgentBuilderConfig } from '../config';
import { ServiceManager } from '../services';
import type { InternalSetupServices, InternalStartServices } from '../services';
import { registerDeductiveAgent } from '../services/execution/run_agent/deductive/register_deductive_agent';
import { createSmlTools } from '../services/tools/builtin/sml';
import { createConnectorTools } from '../services/tools/builtin/connectors';
import { registerBeforeAgentWorkflowsHook } from '../hooks/agent_workflows/register_before_agent_workflows_hook';
import { registerAfterExecutionWorkflowsHook } from '../hooks/agent_workflows/register_after_execution_workflows_hook';
import { registerSkillToolsLoaderHook } from '../hooks/skills/register_skill_tools_loader_hook';
import type { AnalyticsService, TrackingService } from '../telemetry';
import { createRegistrationRecorder } from './registration_recorder';
import type { RegistrationRecorder } from './registration_recorder';

/**
 * What agent builder's services are built from, apart from the lifecycle of the plugin. The plugin
 * hands over Kibana's services and a task process (the process that runs workflows) the ones it
 * builds from its host: there is one implementation of what is registered with the registries, and
 * the registries are the same classes.
 *
 * Everything that is another plugin's start contract is a lazy getter: it is read when a tool or a
 * hook runs, never while the services are built, because the process builds them in another order.
 */
export interface AgentBuilderRunServicesDeps {
  config: AgentBuilderConfig;
  logger: Logger;
  /** Enables the hooks that run an agent's workflows and the workflow tools; absent, they are not registered. */
  workflowsManagement?: WorkflowsServerPluginSetup;
  trackingService?: TrackingService;
  analyticsService?: AnalyticsService;
  cloud?: CloudSetup;
  usageApi?: UsageApiSetup;
  /** The part of the actions plugin that delivers the callbacks of an asynchronous execution. */
  actions: ActionsPluginSetup;
  getActionsStart: () => Promise<ActionsPluginStart>;
  getInferenceStart: () => Promise<InferenceServerStart>;
  /**
   * The SML plugin's start contract, which the SML tools read. A task process does not have it: the
   * tools are then not registered, and the parity guard keeps the runs that read them in Kibana.
   */
  getAgentBuilderSml?: () => AgentBuilderSmlPluginStart;
  getCoreStart: () => Promise<Pick<CoreStart, 'uiSettings' | 'savedObjects'>>;
  /** Kibana registers the global settings of the Deductive agent: a process has them from Core's module. */
  uiSettings?: UiSettingsServiceSetup;
  /** What a registration tells a task process; a task process itself ignores it. */
  taskProcess: TaskProcessSetup;
}

export interface AgentBuilderRunServices {
  serviceManager: ServiceManager;
  /** The registries as the services themselves see them. */
  serviceSetups: InternalSetupServices;
  /**
   * What plugins register with in their `setup()` (and what an `agent-builder` contribution of a
   * task process registers with).
   */
  setupContract: AgentBuilderPluginSetup;
  /** The ids registered with the registries so far: what Kibana sends a process, and what a process compares. */
  registrations: RegistrationRecorder;
  /** The opt-ins plugins registered for the `conversationUpdated` trigger. */
  conversationUpdatedOptIns: ConversationUpdatedOptIn[];
  getInternalServices: () => InternalStartServices;
}

/**
 * Builds the services and registers what agent builder itself registers: the platform tools that
 * read the SML plugin and the connectors, the Deductive agent, and the hooks. The start of the
 * services (`serviceManager.startServices`) is the caller's, once the services they read exist.
 */
export const createAgentBuilderRunServices = (
  deps: AgentBuilderRunServicesDeps
): AgentBuilderRunServices => {
  const { config, logger } = deps;
  const serviceManager = new ServiceManager(config);
  const conversationUpdatedOptIns: ConversationUpdatedOptIn[] = [];

  const registrations = createRegistrationRecorder();
  const serviceSetups = registrations.record(
    serviceManager.setupServices({
      logger: logger.get('services'),
      workflowsManagement: deps.workflowsManagement,
      trackingService: deps.trackingService,
      cloud: deps.cloud,
      usageApi: deps.usageApi,
      actions: deps.actions,
    })
  );

  const getInternalServices = () => {
    const services = serviceManager.internalStart;
    if (!services) {
      throw new Error('getInternalServices called before service init');
    }
    return services;
  };

  // External Deductive execution path (agent + Advanced Settings). Self-contained in the
  // deductive module so the whole temporary integration can be removed by deleting it.
  registerDeductiveAgent({
    getCoreStart: deps.getCoreStart,
    uiSettings: deps.uiSettings,
    agents: serviceSetups.agents,
    register: config.deductive?.register ?? false,
  });

  registerBeforeAgentWorkflowsHook(serviceSetups, {
    workflowsManagement: deps.workflowsManagement,
    logger,
    getInternalServices,
  });

  registerAfterExecutionWorkflowsHook(serviceSetups, {
    workflowsManagement: deps.workflowsManagement,
    logger,
    getInternalServices,
  });

  registerSkillToolsLoaderHook(serviceSetups, {
    analyticsService: deps.analyticsService,
    trackingService: deps.trackingService,
  });

  const { getAgentBuilderSml } = deps;
  if (getAgentBuilderSml) {
    createSmlTools({ getAgentBuilderSml }).forEach((tool) => {
      serviceSetups.tools.register(tool);
    });
  }

  createConnectorTools({
    getActions: deps.getActionsStart,
    getInference: deps.getInferenceStart,
  }).forEach((tool) => {
    serviceSetups.tools.register(tool);
  });

  const setupContract: AgentBuilderPluginSetup = {
    tools: {
      register: serviceSetups.tools.register.bind(serviceSetups.tools),
    },
    agents: {
      register: serviceSetups.agents.register.bind(serviceSetups.agents),
      registerType: serviceSetups.agents.registerType.bind(serviceSetups.agents),
      registerAiIndexResolver: serviceSetups.agents.registerAiIndexResolver.bind(
        serviceSetups.agents
      ),
    },
    attachments: {
      registerType: serviceSetups.attachments.registerType.bind(serviceSetups.attachments),
    },
    renderers: {
      register: serviceSetups.renderers.register.bind(serviceSetups.renderers),
    },
    conversationEvents: {
      register: serviceSetups.conversationEvents.register.bind(serviceSetups.conversationEvents),
    },
    hooks: {
      register: serviceSetups.hooks.register.bind(serviceSetups.hooks),
      registerCycleHook: serviceSetups.hooks.registerCycleHook.bind(serviceSetups.hooks),
    },
    skills: {
      register: serviceSetups.skills.registerSkill.bind(serviceSetups.skills),
    },
    plugins: {
      register: serviceSetups.plugins.register.bind(serviceSetups.plugins),
    },
    conversationTemplates: {
      register: serviceSetups.conversationTemplates.register.bind(
        serviceSetups.conversationTemplates
      ),
    },
    conversations: {
      enableUpdatedTrigger: (optIn) => {
        conversationUpdatedOptIns.push(optIn);
      },
    },
    topSnippets: config.topSnippets,
    taskProcess: deps.taskProcess,
  };

  return {
    serviceManager,
    serviceSetups,
    setupContract,
    registrations,
    conversationUpdatedOptIns,
    getInternalServices,
  };
};
