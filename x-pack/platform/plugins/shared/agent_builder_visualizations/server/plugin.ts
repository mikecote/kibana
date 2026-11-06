/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import type {
  AgentBuilderVisualizationsSetupDependencies,
  AgentBuilderVisualizationsStartDependencies,
  AgentBuilderVisualizationsPluginSetup,
  AgentBuilderVisualizationsPluginStart,
} from './types';
import { registerVisualizationsAgentBuilder } from './register_agent_builder';
import { VISUALIZATIONS_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';
import { visualizationSmlType } from './sml_types/visualization';

export class AgentBuilderVisualizationsPlugin
  implements
    Plugin<
      AgentBuilderVisualizationsPluginSetup,
      AgentBuilderVisualizationsPluginStart,
      AgentBuilderVisualizationsSetupDependencies,
      AgentBuilderVisualizationsStartDependencies
    >
{
  constructor(_context: PluginInitializerContext) {}

  setup(
    _coreSetup: CoreSetup<
      AgentBuilderVisualizationsStartDependencies,
      AgentBuilderVisualizationsPluginStart
    >,
    setupDeps: AgentBuilderVisualizationsSetupDependencies
  ): AgentBuilderVisualizationsPluginSetup {
    // What a task process needs to register what this Kibana registers: the plugin is enabled.
    setupDeps.agentBuilder.taskProcess?.registerSettings(
      VISUALIZATIONS_AGENT_BUILDER_SETTINGS_ID,
      () => ({})
    );
    registerVisualizationsAgentBuilder(setupDeps.agentBuilder);
    setupDeps.agentBuilderSml.registerType(visualizationSmlType);
    return {};
  }

  start(
    _coreStart: CoreStart,
    _startDeps: AgentBuilderVisualizationsStartDependencies
  ): AgentBuilderVisualizationsPluginStart {
    return {};
  }

  stop() {}
}
