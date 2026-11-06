/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerAgentBuilderPlatform } from '../register_agent_builder';
import type { AgentBuilderPlatformCoreSetup } from '../types';

/** The id of the settings the plugin sends a task process. */
export const AGENT_BUILDER_PLATFORM_SETTINGS_ID = 'agentBuilderPlatform';

export interface AgentBuilderPlatformTaskProcessSettings {
  /** The organization of the cloud deployment, which `generate_esql` sends with its requests. */
  organizationId?: string;
}

/**
 * What the plugin registers with agent builder, in the task process of the workflow task types:
 * listed under `taskTypeContributions['agent-builder']` in `kibana.jsonc`. The registrations are the
 * ones `setup()` makes, with the services of the process in place of Kibana's start services.
 *
 * Not registered, because the process has neither the LLM tasks plugin nor the files plugin: the
 * product documentation tool and the image attachment type. A workflow that runs an agent is declined
 * while Kibana has them (the parity guard of agent builder), instead of running with fewer tools.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [AGENT_BUILDER_PLATFORM_SETTINGS_ID] },
  register: (agentBuilder, { host, logger, settings, services }) => {
    // Without the setting the plugin is not enabled in this Kibana, and nothing is registered.
    const sent = settings[AGENT_BUILDER_PLATFORM_SETTINGS_ID] as
      | AgentBuilderPlatformTaskProcessSettings
      | undefined;
    if (!sent) return;
    const { organizationId } = sent;
    const { basePath } = (host as TaskHost).http;

    const coreSetup: AgentBuilderPlatformCoreSetup = {
      getStartServices: async () => [
        await services.getCoreStart(),
        {
          agentBuilder: services.getAgentBuilderStart(),
          actions: (await services.getActionsStart()) as ActionsPluginStart,
          // Not available in a process; the registrations that read them are not made.
          files: undefined as never,
          llmTasks: undefined,
        },
        {},
      ],
      http: { basePath: { get: (request) => basePath.get(request) } },
    };

    registerAgentBuilderPlatform(agentBuilder, {
      coreSetup,
      logger: logger.get('agentBuilderPlatform'),
      organizationId,
      has: { llmTasks: false, files: false },
    });
  },
};
