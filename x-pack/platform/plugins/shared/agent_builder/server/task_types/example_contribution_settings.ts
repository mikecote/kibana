/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';

/**
 * Settings of the contributions that need more than "the plugin is enabled", for the tests that send
 * what Kibana would with every plugin enabled (the checked-in ids, the integration tests of a
 * process). A contribution that is not listed gets `{}`.
 */
const EXAMPLES: Record<string, unknown> = {
  casesAgentBuilder: {
    workflows: {
      config: {
        analyticsV2: { enabled: true },
        attachments: { enabled: true },
        templates: { enabled: true },
        assigneeIdentity: { enabled: true },
      },
      spacesEnabled: true,
      featureCaseOwners: [{ id: 'securitySolutionCasesV3', cases: ['securitySolution'] }],
      isEmailServiceAvailable: false,
      hasAlertStatusChangedListeners: false,
      closeReasonOwners: [],
    },
  },
  mlAgentBuilder: {
    enabledFeatures: { ad: true, dfa: true, nlp: true },
    compatibleModuleType: null,
    spacesEnabled: true,
    cpsEnabled: false,
  },
};

export const getExampleContributionSettings = (
  contributions: Array<Pick<AgentBuilderContribution, 'declares'>>
): Record<string, unknown> =>
  Object.fromEntries(
    contributions.flatMap(({ declares }) =>
      (declares?.settings ?? []).map((id) => [id, EXAMPLES[id] ?? {}])
    )
  );
