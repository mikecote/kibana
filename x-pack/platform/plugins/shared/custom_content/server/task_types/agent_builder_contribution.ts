/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerCustomContentAgentBuilder } from '../register_agent_builder';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const CUSTOM_CONTENT_AGENT_BUILDER_SETTINGS_ID = 'customContentAgentBuilder';

/**
 * What the custom content plugin registers with agent builder, in the task process of the workflow task types: the same registrations as `setup()`, which
 * need nothing but the registration surface. Listed under `taskTypeContributions['agent-builder']` in
 * `kibana.jsonc`. Without the setting the plugin is not enabled in this Kibana, and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [CUSTOM_CONTENT_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { settings }) => {
    if (!settings[CUSTOM_CONTENT_AGENT_BUILDER_SETTINGS_ID]) return;
    registerCustomContentAgentBuilder(agentBuilder);
  },
};
