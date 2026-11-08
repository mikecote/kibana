/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { ExperimentalFeatures } from '../../../common/experimental_features';
import type { EndpointSkillServices } from './endpoint_skill_services';
import { createAutomaticTroubleshootingSkill } from './automatic_troubleshooting';
import { createEndpointResponseActionsSkill } from './endpoint_response_actions';
import { createElasticDefendPolicyManagementSkill } from './elastic_defend_policy_management';

/** Registers Endpoint skills with shared feature gates and an execution service provider. */
export const registerEndpointSecuritySkills = async (
  agentBuilder: Pick<AgentBuilderPluginSetup, 'skills'>,
  experimentalFeatures: ExperimentalFeatures,
  endpointAppContextService: EndpointSkillServices
): Promise<void> => {
  if (experimentalFeatures.automaticTroubleshootingSkill) {
    await agentBuilder.skills.register(
      createAutomaticTroubleshootingSkill(endpointAppContextService, experimentalFeatures)
    );
  }
  if (experimentalFeatures.elasticDefendPolicyManagementSkill) {
    await agentBuilder.skills.register(
      createElasticDefendPolicyManagementSkill({
        endpointAppContextService,
      })
    );
  }
  if (experimentalFeatures.endpointResponseActionsSkill) {
    await agentBuilder.skills.register(
      createEndpointResponseActionsSkill(endpointAppContextService)
    );
  }
};
