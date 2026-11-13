/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerEscalationConversationEvents } from '../escalations/conversation_events';
import { registerInvestigationAgentBuilder } from '../services/register_agent_builder';
import {
  AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID,
  type AgenticInvestigationsTaskProcessSettings,
} from './agentic_investigations_task_process_settings';
import { getAgenticInvestigationsTaskProcessServices } from './create_agentic_investigations_task_process_services';

export const contribution: AgentBuilderContribution = {
  declares: { settings: [AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID] },
  register: (agentBuilder, context) => {
    const settings = context.settings[AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID] as
      | AgenticInvestigationsTaskProcessSettings
      | undefined;
    if (!settings) return;
    if (settings.escalationsEnabled) registerEscalationConversationEvents(agentBuilder);
    registerInvestigationAgentBuilder(
      agentBuilder,
      getAgenticInvestigationsTaskProcessServices(context)
    );
  },
};
