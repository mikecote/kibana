/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerSearchSkills } from '../skills/register_search_skills';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const SEARCH_GETTING_STARTED_AGENT_BUILDER_SETTINGS_ID = 'searchGettingStartedAgentBuilder';

/**
 * The search skills the plugin registers with agent builder, in the task process of the workflow task
 * types. Listed under `taskTypeContributions['agent-builder']` in `kibana.jsonc`. Without the setting
 * the plugin is not enabled in this Kibana (it loads in the search group and in stateful deployments)
 * and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [SEARCH_GETTING_STARTED_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { logger, settings }) => {
    if (!settings[SEARCH_GETTING_STARTED_AGENT_BUILDER_SETTINGS_ID]) return;
    registerSearchSkills({ agentBuilder, logger: logger.get('searchGettingStarted') });
  },
};
