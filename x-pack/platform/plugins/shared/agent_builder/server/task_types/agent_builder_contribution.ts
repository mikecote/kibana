/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// The contract of the `agent-builder` contribution lives in the server package, so that plugins of
// every group can implement it without depending on this plugin.
export { AGENT_BUILDER_CONTRIBUTIONS_KEY } from '@kbn/agent-builder-server';
export type {
  AgentBuilderContribution,
  AgentBuilderContributionContext,
  AgentBuilderContributionDeclares,
  AgentBuilderContributionServices,
} from '@kbn/agent-builder-server';
