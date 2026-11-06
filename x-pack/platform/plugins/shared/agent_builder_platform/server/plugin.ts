/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { PluginConfig } from './config';
import type {
  PluginSetupDependencies,
  PluginStartDependencies,
  AgentBuilderPlatformPluginSetup,
  AgentBuilderPlatformPluginStart,
  AgentBuilderPlatformCoreSetup,
} from './types';
import { registerAgentBuilderPlatform } from './register_agent_builder';
import { AGENT_BUILDER_PLATFORM_SETTINGS_ID } from './task_types/agent_builder_contribution';
import type { AgentBuilderPlatformTaskProcessSettings } from './task_types/agent_builder_contribution';
import { createConnectorSmlType } from './sml_types/connector';
import { createConnectorLifecycleHandler } from './connector_lifecycle/connector_lifecycle_handler';
import { setAgentBuilderDashboard } from './dashboard/install_dashboard';

export class AgentBuilderPlatformPlugin
  implements
    Plugin<
      AgentBuilderPlatformPluginSetup,
      AgentBuilderPlatformPluginStart,
      PluginSetupDependencies,
      PluginStartDependencies
    >
{
  private logger: Logger;

  constructor(context: PluginInitializerContext<PluginConfig>) {
    this.logger = context.logger.get();
  }

  setup(
    coreSetup: CoreSetup<PluginStartDependencies, AgentBuilderPlatformPluginStart>,
    setupDeps: PluginSetupDependencies
  ): AgentBuilderPlatformPluginSetup {
    // What a task process needs to register what this Kibana registers.
    setupDeps.agentBuilder.taskProcess?.registerSettings(
      AGENT_BUILDER_PLATFORM_SETTINGS_ID,
      (): AgentBuilderPlatformTaskProcessSettings => ({
        organizationId: setupDeps.cloud?.organizationId,
      })
    );
    registerAgentBuilderPlatform(setupDeps.agentBuilder, {
      coreSetup: coreSetup as AgentBuilderPlatformCoreSetup,
      logger: this.logger,
      organizationId: setupDeps.cloud?.organizationId,
      // Kibana has the LLM tasks plugin and the files plugin whenever they are enabled.
      has: { llmTasks: true, files: true },
    });

    const connectorSmlType = createConnectorSmlType({
      getActionSavedObjectsClient: async (request) => {
        const [coreStart] = await coreSetup.getStartServices();
        return coreStart.savedObjects.getScopedClient(request, { includedHiddenTypes: ['action'] });
      },
      logger: this.logger.get('sml-connector'),
    });
    setupDeps.agentBuilderSml.registerType(connectorSmlType);

    const connectorLifecycleHandler = createConnectorLifecycleHandler({
      logger: this.logger.get('connector-lifecycle'),
      getStartServices: coreSetup.getStartServices,
    });

    setupDeps.actions.registerConnectorLifecycleListener({
      connectorTypes: '*',
      onPostCreate: connectorLifecycleHandler.onPostCreate,
      onPostDelete: connectorLifecycleHandler.onPostDelete,
    });

    return {};
  }

  start(coreStart: CoreStart): AgentBuilderPlatformPluginStart {
    return {
      tracingFeatures: {
        setDashboard: ({ enabled, spaceId }) =>
          setAgentBuilderDashboard(coreStart, enabled, spaceId, this.logger),
      },
    };
  }

  stop() {}
}
