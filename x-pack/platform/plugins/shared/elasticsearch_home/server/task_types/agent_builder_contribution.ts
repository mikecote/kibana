/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { registerSearchSkills } from '../skills/register_search_skills';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const ELASTICSEARCH_HOME_AGENT_BUILDER_SETTINGS_ID = 'elasticsearchHomeAgentBuilder';

export interface ElasticsearchHomeAgentBuilderSettings {
  /** The serverless project type, which decides whether the search skills are registered. */
  projectType?: string;
}

/**
 * What the plugin registers with agent builder, in the task process of the workflow task types: the
 * search skills of a VectorDB project, as `setup()` registers them. Listed under
 * `taskTypeContributions['agent-builder']` in `kibana.jsonc`. The project type is Kibana's, sent as a
 * setting; without the setting the plugin is not enabled in Kibana and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [ELASTICSEARCH_HOME_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { logger, settings }) => {
    const sent = settings[ELASTICSEARCH_HOME_AGENT_BUILDER_SETTINGS_ID] as
      | ElasticsearchHomeAgentBuilderSettings
      | undefined;
    if (!sent) return;
    registerSearchSkills({
      agentBuilder,
      projectType: sent.projectType ?? undefined,
      logger: logger.get('elasticsearchHome'),
    });
  },
};
