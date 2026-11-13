/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerDiscoverAgentBuilder } from '../agent_builder/register_agent_builder';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const DISCOVER_AGENT_BUILDER_SETTINGS_ID = 'discoverAgentBuilder';

/**
 * What Discover registers with agent builder, in the task process of the workflow task types: the same registrations as `setup()`, which
 * need nothing but the registration surface. Listed under `taskTypeContributions['agent-builder']` in
 * `kibana.jsonc`. Without the setting the plugin is not enabled in this Kibana, and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [DISCOVER_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { settings }) => {
    if (!settings[DISCOVER_AGENT_BUILDER_SETTINGS_ID]) return;
    registerDiscoverAgentBuilder(agentBuilder);
  },
};
