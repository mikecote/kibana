/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { registerTools } from './tools';
import { registerAttachmentTypes } from './attachment_types';
import { registerConversationEventTypes } from './conversation_events';
import { registerConversationTemplates } from './conversation_templates';
import { registerSkills } from './skills';
import type { AgentBuilderPlatformCoreSetup } from './types';

export interface AgentBuilderPlatformRegistrationServices {
  coreSetup: AgentBuilderPlatformCoreSetup;
  logger: Logger;
  organizationId?: string;
}

/**
 * What the plugin registers with agent builder: tools, attachment types, conversation templates and
 * event types, and skills. Called by `setup()` and by the `agent-builder` contribution to a task
 * process, with the same registration surface, so that the process registers what Kibana does.
 */
export const registerAgentBuilderPlatform = (
  agentBuilder: AgentBuilderPluginSetup,
  { coreSetup, logger, organizationId }: AgentBuilderPlatformRegistrationServices
) => {
  registerTools({
    coreSetup,
    agentBuilder,
    organizationId,
  });
  registerAttachmentTypes({ coreSetup, agentBuilder, logger });
  registerConversationTemplates({ agentBuilder });
  registerConversationEventTypes({ agentBuilder });
  const getActionsStart = async () => {
    const [, startDeps] = await coreSetup.getStartServices();
    return startDeps.actions;
  };
  registerSkills(agentBuilder, getActionsStart, logger);
};
