/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger, FeatureFlagsStart, CoreStart } from '@kbn/core/server';
import type { AgentBuilderPluginSetup, BuiltinToolDefinition } from '@kbn/agent-builder-server';
import type { ZodObject } from '@kbn/zod/v4';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { SandboxPluginStart } from '@kbn/sandbox-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { NightshiftTaskProcessSettings } from './task_types/nightshift_task_process_settings';
import type { NightshiftProcessServices } from './task_types/create_nightshift_process_services';
import { notificationRoutingAttachment } from './lib/notifications/notification_routing';
import { registerInvestigationAgentType } from './agents/investigation';
import { registerDecisionTreeReinforcementAgentType } from './agents/decision_tree_reinforcement';
import { createDecisionTreeTools } from './tools/decision_tree';
import { createSandboxBashTool } from './tools/sandbox_bash/tool';
import { createSandboxViewFileTool } from './tools/sandbox_bash/view_file_tool';
import { createSandboxStrReplaceTool } from './tools/sandbox_bash/str_replace_tool';
import { createSandboxWriteFileTool } from './tools/sandbox_bash/write_file_tool';
import { createConnectorCredentialResolver } from './tools/sandbox_bash/connector_credentials';
import { createSandboxWorkspaceManager } from './tools/sandbox_bash/sandbox_workspace_manager';
import {
  createSandboxOutputRedactorProvider,
  withSandboxOutputRedaction,
} from './tools/sandbox_bash/sandbox_output_redaction';
import { createSandboxToolAvailability } from './tools/sandbox_bash/sandbox_tool_availability';

export interface NightshiftAgentRegistrationDependencies {
  agentBuilder: AgentBuilderPluginSetup;
  settings: NightshiftTaskProcessSettings;
  logger: Logger;
  getAgentBuilder: NightshiftProcessServices['getAgentBuilder'];
  getRoutingService: () => NightshiftProcessServices['routingService'];
  customContextClient: Pick<NightshiftProcessServices['customContext'], 'getInstructions'>;
  sandboxSecretsClient: Pick<
    NightshiftProcessServices['sandboxSecrets'],
    'listKeysForSandbox' | 'getRedactionValues' | 'resolveForCommand'
  >;
  getSandboxStart: () => SandboxPluginStart | undefined;
  getActions: () =>
    | Pick<
        ActionsPluginStart,
        'getActionsClientWithRequest' | 'getActionsAuthorizationWithRequest' | 'inMemoryConnectors'
      >
    | undefined;
  getFeatureFlags: () => Pick<FeatureFlagsStart, 'getBooleanValue$'> | undefined;
  getSecurity: () =>
    | {
        authz: Pick<
          SecurityPluginStart['authz'],
          'mode' | 'actions' | 'checkPrivilegesDynamicallyWithRequest'
        >;
      }
    | undefined;
  getSpaceId: (request: KibanaRequest) => string;
  getCoreSecurity: () => Pick<CoreStart['security'], 'authc'> | undefined;
}

/** Registers the native Nightshift agents, attachments and sandbox tools in either lifecycle. */
export const registerNightshiftAgentBuilder = ({
  agentBuilder,
  settings,
  logger,
  getAgentBuilder,
  getRoutingService,
  customContextClient,
  sandboxSecretsClient,
  getSandboxStart,
  getActions,
  getFeatureFlags,
  getSecurity,
  getSpaceId,
  getCoreSecurity,
}: NightshiftAgentRegistrationDependencies): void => {
  notificationRoutingAttachment.registerAttachmentType(agentBuilder, {
    getService: () => getRoutingService(),
    assertCanRead: async () => {},
    assertCanReadConversation: async (request, conversationId) => {
      const start = getAgentBuilder();
      if (!start) {
        throw new Error('agentBuilder is not available');
      }
      const conversations = await start.conversations.getScopedClient({ request });
      await conversations.get(conversationId);
    },
    logger,
  });
  const { telemetryConnectorId } = settings;
  registerInvestigationAgentType(agentBuilder, {
    sandboxEnabled: settings.sandboxAvailable === true,
    cortexEnabled: settings.cortexEnabled === true,
    memoryEnabled: settings.memoryEnabled === true,
    decisionTreesEnabled: settings.decisionTreesEnabled === true,
    investigationToolsEnabled: settings.agenticInvestigationsAvailable === true,
    proposalsEnabled: settings.proposalsAvailable === true,
    telemetryConnectorId,
    getCustomContextInstructions: ({ request, spaceId }) =>
      customContextClient.getInstructions(request, spaceId),
    logger: logger.get('custom_context'),
  });
  if (settings.decisionTreesEnabled === true) {
    registerDecisionTreeReinforcementAgentType(agentBuilder);
  }

  if (settings.sandboxAvailable) {
    const sandboxLogger = logger.get('sandbox');

    // Tools are registered in setup() but only run after start(), so read start deps lazily.
    const sandboxWorkspaceManager = createSandboxWorkspaceManager({
      getDeps: () => ({ actions: getActions(), sandboxSecretsClient }),
      telemetryConnectorId,
      telemetryReadableIndices: settings.telemetryReadableIndices,
      logger: sandboxLogger,
    });
    const resolveConnectorCredentials = createConnectorCredentialResolver({
      getDeps: () => ({ actions: getActions() }),
      logger: sandboxLogger.get('connector_credentials'),
    });
    const outputRedactionLogger = sandboxLogger.get('output_redaction');
    const redaction = {
      getOutputRedactor: createSandboxOutputRedactorProvider({
        getDeps: () => ({ actions: getActions(), sandboxSecretsClient }),
      }),
      logger: outputRedactionLogger,
    };
    const availability = createSandboxToolAvailability({
      getDeps: () => ({ featureFlags: getFeatureFlags(), security: getSecurity() }),
    });
    const registerSandboxTool = <TSchema extends ZodObject>(tool: BuiltinToolDefinition<TSchema>) =>
      agentBuilder.tools.register({
        ...withSandboxOutputRedaction(tool, redaction),
        availability,
      });

    registerSandboxTool(
      createSandboxBashTool({
        getSandboxStart,
        sandboxWorkspaceManager,
        resolveConnectorCredentials,
        sandboxSecretsClient,
        logger: sandboxLogger,
      })
    );
    registerSandboxTool(
      createSandboxViewFileTool({
        getSandboxStart,
        sandboxWorkspaceManager,
        logger: sandboxLogger,
      })
    );
    registerSandboxTool(
      createSandboxStrReplaceTool({
        getSandboxStart,
        sandboxWorkspaceManager,
        logger: sandboxLogger,
      })
    );
    registerSandboxTool(
      createSandboxWriteFileTool({
        getSandboxStart,
        sandboxWorkspaceManager,
        logger: sandboxLogger,
      })
    );

    if (settings.decisionTreesEnabled === true) {
      const decisionTreeLogger = logger.get('decision_trees');
      for (const tool of createDecisionTreeTools({
        getSandboxStart,
        connectorNames: telemetryConnectorId ? [telemetryConnectorId] : [],
        getSpaceId,
        getUsername: (req: KibanaRequest) => getCoreSecurity()?.authc.getCurrentUser(req)?.username,
        logger: decisionTreeLogger,
      })) {
        agentBuilder.tools.register(tool);
      }
    }
  }
};
