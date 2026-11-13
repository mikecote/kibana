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
import { registerAgentBuilderPlatformSml } from './sml_types/register_sml';
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
  private startDeps?: PluginStartDependencies;

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
        // The product documentation tool answers "not available" without the LLM tasks plugin.
        llmTasks: Boolean(this.startDeps?.llmTasks),
      })
    );
    registerAgentBuilderPlatform(setupDeps.agentBuilder, {
      coreSetup: coreSetup as AgentBuilderPlatformCoreSetup,
      logger: this.logger,
      organizationId: setupDeps.cloud?.organizationId,
    });

    registerAgentBuilderPlatformSml(setupDeps.agentBuilderSml, {
      getCoreStart: async () => (await coreSetup.getStartServices())[0],
      logger: this.logger,
    });

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

  start(coreStart: CoreStart, startDeps: PluginStartDependencies): AgentBuilderPlatformPluginStart {
    this.startDeps = startDeps;
    return {
      tracingFeatures: {
        setDashboard: ({ enabled, spaceId }) =>
          setAgentBuilderDashboard(coreStart, enabled, spaceId, this.logger),
      },
    };
  }

  stop() {}
}
