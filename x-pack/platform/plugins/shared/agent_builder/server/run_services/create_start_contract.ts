/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { InternalStartServices } from '../services';
import { createAttachmentPublicClient } from '../services/attachments';
import { createConversationPublicClient } from '../services/conversation/conversation_public_client';
import { createModelProviderFactory } from '../services/execution/runner/model_provider';
import type { TrackingService } from '../telemetry';

/**
 * The start contract plugins read as `agentBuilder` in their start dependencies, built from the
 * started services: by the plugin in Kibana, and by a task process, so that what a plugin reads of
 * agent builder when a tool runs is the same in both.
 */
export const createAgentBuilderStartContract = ({
  startServices,
  coreStart,
  spaces,
  inference,
  searchInferenceEndpoints,
  trackingService,
  logger,
  onSkillRegistered,
}: {
  startServices: InternalStartServices;
  coreStart: Pick<CoreStart, 'elasticsearch' | 'security' | 'savedObjects'>;
  spaces?: SpacesPluginStart;
  inference: InferenceServerStart;
  searchInferenceEndpoints: SearchInferenceEndpointsPluginStart;
  trackingService?: TrackingService;
  logger: Logger;
  /** Told the id of each skill registered after start (the recorder of the registrations). */
  onSkillRegistered?: (id: string) => void;
}): AgentBuilderPluginStart => {
  const {
    tools,
    agents,
    skills,
    runnerFactory,
    execution,
    plugins,
    conversations,
    conversationTemplates,
    attachments,
  } = startServices;
  const runner = runnerFactory.getRunner();

  const modelProviderFactory = createModelProviderFactory({
    inference,
    trackingService,
    searchInferenceEndpoints,
    logger: logger.get('model-provider'),
    spaces,
    security: coreStart.security,
    elasticsearch: coreStart.elasticsearch,
  });

  return {
    agents: {
      getRegistry: ({ request }) => agents.getRegistry({ request }),
      ensure: agents.ensure,
      runAgent: runner.runAgent.bind(runner),
    },
    tools: {
      getRegistry: ({ request }) => tools.getRegistry({ request }),
      execute: runner.runTool.bind(runner),
    },
    skills: {
      getRegistry: skills.getRegistry.bind(skills),
      register: async (skill) => {
        await skills.registerSkill(skill);
        onSkillRegistered?.(skill.id);
      },
    },
    plugins: {
      getRegistry: ({ request }) => plugins.getRegistry({ request }),
    },
    execution: {
      executeAgent: execution.executeAgent.bind(execution),
      getExecution: execution.getExecution.bind(execution),
      findExecutions: execution.findExecutions.bind(execution),
    },
    runtime: {
      createModelProvider: modelProviderFactory,
    },
    conversations: {
      getScopedClient: async ({ request }) => {
        const client = await conversations.getScopedClient({ request });
        const agentRegistry = await agents.getRegistry({ request });
        return createConversationPublicClient({ client, agentRegistry, source: 'server_api' });
      },
    },
    attachments: {
      getScopedClient: async ({ request }) =>
        createAttachmentPublicClient({
          request,
          conversationsService: conversations,
          attachmentsService: attachments,
          coreStart,
          spaces,
          source: 'server_api',
        }),
    },
    conversationTemplates,
  };
};
