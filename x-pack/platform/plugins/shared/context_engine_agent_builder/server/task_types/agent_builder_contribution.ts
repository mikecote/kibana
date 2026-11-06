/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup } from '@kbn/core/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import {
  contextEngineGlobalUiSettings,
  contextEngineSpaceUiSettings,
} from '@kbn/context-engine-plugin/server/ui_settings';
import { createContextEngineRunServices } from '@kbn/context-engine-plugin/server/run_services/create_context_engine_run_services';
import type { ContextEnginePluginStart } from '@kbn/context-engine-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { registerContextEngineAgentBuilderIntegration } from '../register_agent_builder_integration';
import type {
  ContextEngineAgentBuilderPluginStart,
  ContextEngineAgentBuilderStartDependencies,
} from '../types';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const CONTEXT_ENGINE_AGENT_BUILDER_SETTINGS_ID = 'contextEngineAgentBuilder';

/**
 * What the plugin registers with agent builder, in the task process of the workflow task types: the
 * agent, the attachment types, the AI index resolver and the tools, which `setup()` registers with
 * the same function. The context engine's services (the AI index service and the reads over it, the
 * signals and improvements stores) are built by `createContextEngineRunServices` over the host.
 *
 * Differences from Kibana: no AI index that other plugins register as managed is known to the
 * process, and the workflows management API is the one of the process (reading and running saved
 * workflows): the tools that save an automation need the workflows service of Kibana and fail in a
 * process with "only available in Kibana". Without the setting the plugin is not enabled in this
 * Kibana, and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [CONTEXT_ENGINE_AGENT_BUILDER_SETTINGS_ID],
    // Read by the availability of the tools (`contextEngine:enabled`, per space) and the AI index read
    // service (`contextEngine:memory:enabled`, global), which the context engine registers in Kibana.
    uiSettings: [contextEngineSpaceUiSettings],
    globalUiSettings: [contextEngineGlobalUiSettings],
  },
  register: (agentBuilder, { host, logger, settings, services }) => {
    if (!settings[CONTEXT_ENGINE_AGENT_BUILDER_SETTINGS_ID]) return;
    // What the registrations read of the host is read when a tool runs, not while registering.
    let contextEngine: ContextEnginePluginStart | undefined;
    const getContextEngine = () => {
      if (!contextEngine) {
        const { elasticsearch, savedObjects, uiSettings, security } = host as TaskHost;
        if (!uiSettings) throw new Error('The workflows task module did not get ui settings');
        contextEngine = createContextEngineRunServices({
          esClient: elasticsearch.asInternalUser,
          logger: logger.get('contextEngine'),
          savedObjects,
          uiSettings,
          audit: security.audit,
          getSpaceId: (request) => (request as { spaceId?: string }).spaceId ?? 'default',
        });
      }
      return contextEngine;
    };

    const coreSetup = {
      getStartServices: async () => [
        await services.getCoreStart(),
        {
          contextEngine: getContextEngine(),
          security: (host as TaskHost).plugins?.security as unknown as SecurityPluginStart,
        },
        {},
      ],
    } as unknown as CoreSetup<
      ContextEngineAgentBuilderStartDependencies,
      ContextEngineAgentBuilderPluginStart
    >;
    // The process's workflows API, resolved when a tool calls it.
    const workflowsManagement = new Proxy(
      {},
      {
        get: (_target, property) =>
          (services.getWorkflowsManagement() as Record<string | symbol, unknown>)[property],
      }
    ) as WorkflowsServerPluginSetup['management'];
    registerContextEngineAgentBuilderIntegration({
      coreSetup,
      agentBuilder,
      workflowsManagement,
    });
  },
};
