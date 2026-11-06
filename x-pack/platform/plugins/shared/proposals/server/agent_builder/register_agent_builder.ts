/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { registerProposalAttachment } from '../attachments';
import type { ProposalPrivilegesChecker } from '../services/check_proposal_privileges';
import type { ProposalsService } from '../services/proposals_service';
import { createProposalTool } from '../tools/create_proposal_tool';
import { createProposalManagementSkill } from './skills/proposal_management';
import { reviseProposalTool } from './tools/revise_proposal_tool';

export interface ProposalsAgentBuilderServices {
  /** Read when a tool or the attachment runs, never while registering. */
  getProposalsService: () => ProposalsService;
  getWorkflowsApi: () => WorkflowsServerPluginSetup['management'];
  privileges: ProposalPrivilegesChecker;
  logger: Logger;
}

/**
 * What the plugin registers with agent builder: the revise and create tools, the management skill
 * and the proposal attachment type. Called by `setup()` and by the `agent-builder` contribution to
 * a task process, with the same registration surface.
 */
export const registerProposalsAgentBuilder = (
  agentBuilder: AgentBuilderPluginSetup,
  { getProposalsService, getWorkflowsApi, privileges, logger }: ProposalsAgentBuilderServices
) => {
  agentBuilder.tools.register(reviseProposalTool({ getProposalsService, privileges }));
  agentBuilder.skills.register(
    createProposalManagementSkill((request) => privileges.canManage(request))
  );
  // Reads go through the internal user, so the formatter has to check the caller's privilege itself.
  registerProposalAttachment(agentBuilder, { getProposalsService, privileges, logger });
  // Lets an agent propose an action in its own conversation through the gate workflow.
  agentBuilder.tools.register(
    createProposalTool({ getProposalsService, getWorkflowsApi, privileges, logger })
  );
};
