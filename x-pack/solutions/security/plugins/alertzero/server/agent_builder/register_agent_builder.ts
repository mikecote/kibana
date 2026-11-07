/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { TEMPLATE_ID_ESCALATION, TEMPLATE_ID_INVESTIGATION } from '@kbn/alertzero-common';
import { registerAgentType } from '../agent';
import type { ActionsService } from '../services/actions/actions_service';
import { listActionsTool } from '../agent_builder_tools/list_actions_tool';
import type { AssertAlertZeroAccess } from '../agent_builder_tools/assert_alertzero_access';
import { createActionDiscoverySkill } from './skills/action_discovery';
import { registerAttachments } from './attachments/register_attachments';

/** Registers AlertZero's native agent, tools, skills, attachments and conversation trigger. */
export const registerAlertZeroAgentBuilder = ({
  agentBuilder,
  getActionsService,
  assertAlertZeroAccess,
  isEnabledForRequest,
}: {
  agentBuilder: AgentBuilderPluginSetup;
  getActionsService: () => Pick<ActionsService, 'list'>;
  assertAlertZeroAccess: AssertAlertZeroAccess;
  isEnabledForRequest: (request: KibanaRequest) => Promise<boolean>;
}): void => {
  registerAgentType(agentBuilder);
  registerAttachments(agentBuilder);
  agentBuilder.tools.register(listActionsTool(getActionsService, assertAlertZeroAccess));
  agentBuilder.skills.register(createActionDiscoverySkill(assertAlertZeroAccess));
  agentBuilder.conversations.enableUpdatedTrigger({
    templateIds: [TEMPLATE_ID_INVESTIGATION, TEMPLATE_ID_ESCALATION],
    isEnabled: isEnabledForRequest,
  });
};
