/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { registerNightshiftAgentBuilder } from '../register_agent_builder';
import { installInvestigationAgent } from '../lib/install_investigation_agent';
import type { NightshiftProcessServices } from './create_nightshift_process_services';
import { NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID } from './nightshift_task_process_settings';
import type { NightshiftTaskProcessSettings } from './nightshift_task_process_settings';
import { contribution as workflowContribution } from './workflow_steps_contribution';

/** Registers the same native Nightshift agents, tools and routing attachments as Main. */
export const contribution: AgentBuilderContribution = {
  declares: workflowContribution.declares,
  register: (agentBuilder, context) => {
    const settings = context.settings[NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] as
      | NightshiftTaskProcessSettings
      | undefined;
    if (!settings?.agentBuilderAvailable) return;
    const host = context.host as TaskHost;
    const getRuntime = (): NightshiftProcessServices =>
      context.services.getService<NightshiftProcessServices>('nightshift.runtime');
    registerNightshiftAgentBuilder({
      agentBuilder,
      settings,
      logger: context.logger,
      getAgentBuilder: context.services.getAgentBuilderStart,
      getRoutingService: () => getRuntime().routingService,
      customContextClient: {
        getInstructions: (...args) => getRuntime().customContext.getInstructions(...args),
      },
      sandboxSecretsClient: {
        listKeysForSandbox: (...args) => getRuntime().sandboxSecrets.listKeysForSandbox(...args),
        getRedactionValues: (...args) => getRuntime().sandboxSecrets.getRedactionValues(...args),
        resolveForCommand: (...args) => getRuntime().sandboxSecrets.resolveForCommand(...args),
      },
      getSandboxStart: () => getRuntime().getSandboxStart(),
      getActions: () => getRuntime().getActions(),
      getFeatureFlags: () => host.featureFlags,
      getSecurity: () =>
        settings.securityAvailable
          ? (host.plugins?.security as SecurityTaskPluginStart | undefined)
          : undefined,
      getSpaceId: (request) =>
        settings.spacesEnabled
          ? context.services
              .getService<SpacesPluginStart>('spaces')
              .spacesService.getSpaceId(request)
          : DEFAULT_SPACE_ID,
      getCoreSecurity: () => host.security,
    });
  },
  registerAtStart: async (agentBuilder, context) => {
    const settings = context.settings[NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID] as
      | NightshiftTaskProcessSettings
      | undefined;
    if (!settings?.agentBuilderAvailable) return;
    const getRuntime = (): NightshiftProcessServices =>
      context.services.getService<NightshiftProcessServices>('nightshift.runtime');
    await installInvestigationAgent({
      agentBuilder,
      spaceId: DEFAULT_SPACE_ID,
      availability: {
        cacheMode: 'none',
        handler: (params) => getRuntime().getAgentAvailability().handler(params),
      },
    });
  },
};
