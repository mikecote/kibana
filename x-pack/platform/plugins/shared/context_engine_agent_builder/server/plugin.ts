/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import type {
  ContextEngineAgentBuilderPluginSetup,
  ContextEngineAgentBuilderPluginStart,
  ContextEngineAgentBuilderSetupDependencies,
  ContextEngineAgentBuilderStartDependencies,
} from './types';
import { registerContextEngineAgentBuilderIntegration } from './register_agent_builder_integration';
import { CONTEXT_ENGINE_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';
import { registerContextEngineInferenceFeatures } from './register_inference_features';

export class ContextEngineAgentBuilderPlugin
  implements
    Plugin<
      ContextEngineAgentBuilderPluginSetup,
      ContextEngineAgentBuilderPluginStart,
      ContextEngineAgentBuilderSetupDependencies,
      ContextEngineAgentBuilderStartDependencies
    >
{
  constructor(_initializerContext: PluginInitializerContext) {}

  setup(
    coreSetup: CoreSetup<
      ContextEngineAgentBuilderStartDependencies,
      ContextEngineAgentBuilderPluginStart
    >,
    setupDeps: ContextEngineAgentBuilderSetupDependencies
  ): ContextEngineAgentBuilderPluginSetup {
    // What a task process needs to register what this Kibana registers: the plugin is enabled.
    setupDeps.agentBuilder.taskProcess?.registerSettings(
      CONTEXT_ENGINE_AGENT_BUILDER_SETTINGS_ID,
      () => ({})
    );
    registerContextEngineAgentBuilderIntegration({
      coreSetup,
      agentBuilder: setupDeps.agentBuilder,
      workflowsManagement: setupDeps.workflowsManagement.management,
    });

    if (setupDeps.searchInferenceEndpoints) {
      registerContextEngineInferenceFeatures(setupDeps.searchInferenceEndpoints);
    }

    return {};
  }

  start(
    _coreStart: CoreStart,
    _startDeps: ContextEngineAgentBuilderStartDependencies
  ): ContextEngineAgentBuilderPluginStart {
    return {};
  }

  stop() {}
}
