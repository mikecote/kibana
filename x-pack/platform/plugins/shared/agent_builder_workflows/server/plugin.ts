/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { PluginConfig } from './config';
import type {
  PluginSetupDependencies,
  PluginStartDependencies,
  AgentBuilderWorkflowsPluginSetup,
  AgentBuilderWorkflowsPluginStart,
} from './types';
import { WorkflowsAiTelemetryClient } from './telemetry/workflows_ai_telemetry_client';
import { registerWorkflowsAgentBuilder } from './register_agent_builder';
import { WORKFLOWS_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export class AgentBuilderWorkflowsPlugin
  implements
    Plugin<
      AgentBuilderWorkflowsPluginSetup,
      AgentBuilderWorkflowsPluginStart,
      PluginSetupDependencies,
      PluginStartDependencies
    >
{
  private readonly logger: Logger;
  private api: WorkflowsManagementApi | null = null;
  private security?: SecurityPluginStart;

  constructor(context: PluginInitializerContext<PluginConfig>) {
    this.logger = context.logger.get();
  }

  setup(
    coreSetup: CoreSetup<PluginStartDependencies, AgentBuilderWorkflowsPluginStart>,
    setupDeps: PluginSetupDependencies
  ): AgentBuilderWorkflowsPluginSetup {
    const { agentBuilder, agentBuilderSml, workflowsManagement } = setupDeps;
    this.api = workflowsManagement.management;

    // What a task process needs to register what this Kibana registers: the plugin is enabled.
    agentBuilder.taskProcess?.registerSettings(WORKFLOWS_AGENT_BUILDER_SETTINGS_ID, () => ({}));
    registerWorkflowsAgentBuilder(
      { agentBuilder, agentBuilderSml },
      {
        workflowsManagement,
        getSecurity: () => this.security,
        aiTelemetryClient: new WorkflowsAiTelemetryClient(coreSetup.analytics, this.logger),
      }
    );

    return {};
  }

  start(
    coreStart: CoreStart,
    startDeps: PluginStartDependencies
  ): AgentBuilderWorkflowsPluginStart {
    this.security = startDeps.security;
    if (this.api) {
      this.api.setSmlClient(startDeps.agentBuilderSml, this.logger.get('sml'));
    }
    return {};
  }

  stop() {}
}
