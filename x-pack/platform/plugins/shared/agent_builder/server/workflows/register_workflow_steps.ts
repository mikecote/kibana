/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import { createAttachmentPublicClient } from '../services/attachments';
import type { ServiceManager } from '../services';
import { getRunAgentStepDefinition } from '../step_types';
import { registerAttachmentWorkflowSteps, registerConversationWorkflowSteps } from '.';

export interface AgentBuilderWorkflowStepsDeps {
  serviceManager: ServiceManager;
  /** Core's start services: Kibana's, or a task process's. */
  getCoreStart: () => Promise<Pick<CoreStart, 'savedObjects'>>;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
}

/**
 * The steps that run an agent and read and write conversations and attachments, which read the
 * services of the plugin (and through them the registries other plugins fill in): used by `plugin.ts`
 * and by the contribution to the task process of the workflow task types.
 */
export const registerAgentBuilderWorkflowSteps = (
  workflowsExtensions: Pick<WorkflowsExtensionsServerPluginSetup, 'registerStepDefinition'>,
  { serviceManager, getCoreStart, getSpaces }: AgentBuilderWorkflowStepsDeps
) => {
  workflowsExtensions.registerStepDefinition(getRunAgentStepDefinition(serviceManager));

  registerConversationWorkflowSteps(workflowsExtensions, {
    getConversationClient: async (request) => {
      const services = serviceManager.internalStart;
      if (!services) {
        throw new Error('Conversation service not available — plugin has not started');
      }
      return services.conversations.getScopedClient({ request });
    },
    getAgentRegistry: async (request) => {
      const services = serviceManager.internalStart;
      if (!services) {
        throw new Error('Agents service not available — plugin has not started');
      }
      return services.agents.getRegistry({ request });
    },
    getExecutionService: () => {
      const services = serviceManager.internalStart;
      if (!services) {
        throw new Error('Execution service not available — plugin has not started');
      }
      return services.execution;
    },
  });

  registerAttachmentWorkflowSteps(workflowsExtensions, {
    getAttachmentClient: async (request) => {
      const services = serviceManager.internalStart;
      if (!services) {
        throw new Error('Attachment client not available — plugin has not started');
      }
      const [coreStart, spaces] = await Promise.all([getCoreStart(), getSpaces()]);
      return createAttachmentPublicClient({
        request,
        conversationsService: services.conversations,
        attachmentsService: services.attachments,
        coreStart: coreStart as CoreStart,
        spaces,
        source: 'workflow',
      });
    },
  });
};
