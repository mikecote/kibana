/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  Plugin,
  PluginInitializerContext,
  Logger,
} from '@kbn/core/server';
import type {
  AgentBuilderDashboardsSetupDependencies,
  AgentBuilderDashboardsStartDependencies,
  AgentBuilderDashboardsPluginSetup,
  AgentBuilderDashboardsPluginStart,
} from './types';
import { registerDashboardsAgentBuilder } from './register_agent_builder';
import { DASHBOARDS_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';
import { createDashboardAppStateValidator } from './tools/generate/validate_dashboard_app_state';

export class AgentBuilderDashboardsPlugin
  implements
    Plugin<
      AgentBuilderDashboardsPluginSetup,
      AgentBuilderDashboardsPluginStart,
      AgentBuilderDashboardsSetupDependencies,
      AgentBuilderDashboardsStartDependencies
    >
{
  private readonly logger: Logger;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  setup(
    coreSetup: CoreSetup<
      AgentBuilderDashboardsStartDependencies,
      AgentBuilderDashboardsPluginStart
    >,
    setupDeps: AgentBuilderDashboardsSetupDependencies
  ): AgentBuilderDashboardsPluginSetup {
    const getDashboardClient = async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return startDeps.dashboard.client;
    };
    const getDashboardValidator = async () => {
      const [, startDeps] = await coreSetup.getStartServices();
      return createDashboardAppStateValidator(startDeps.embeddable);
    };

    // What a task process needs to register what this Kibana registers: the plugin is enabled.
    setupDeps.agentBuilder.taskProcess?.registerSettings(
      DASHBOARDS_AGENT_BUILDER_SETTINGS_ID,
      () => ({})
    );
    registerDashboardsAgentBuilder(
      { agentBuilder: setupDeps.agentBuilder, agentBuilderSml: setupDeps.agentBuilderSml },
      { logger: this.logger, getDashboardClient, getDashboardValidator }
    );

    return {};
  }

  start(
    _coreStart: CoreStart,
    _startDeps: AgentBuilderDashboardsStartDependencies
  ): AgentBuilderDashboardsPluginStart {
    return {};
  }

  stop() {}
}
