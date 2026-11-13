/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { ExperimentalFeatures } from '../../../common/experimental_features';
import type { EndpointSkillServices } from './endpoint_skill_services';
import type { SecuritySkillServices } from './services';
import type { EntityAnalyticsMlServices } from '../../lib/entity_analytics/ml_anomaly_detection/ml_services';
import { getEntityAnalyticsSkill } from './entity_analytics';
import { findSecurityMlJobsSkill } from './find_security_ml_jobs';
import { createFindRulesSkill } from './find_rules';
import { createRecommendPrebuiltRulesSkill } from './recommend_prebuilt_rules';

import { registerEndpointSecuritySkills } from './register_endpoint_skills';
import { registerStaticSecuritySkills } from './register_static_skills';

interface RegisterSkillsOpts {
  agentBuilder: AgentBuilderPluginSetup;
  experimentalFeatures: ExperimentalFeatures;
  getStartServices: SecuritySkillServices['getStartServices'];
  kibanaVersion: string;
  logger: Logger;
  ml: EntityAnalyticsMlServices | undefined;
  options: {
    endpointAppContextService: EndpointSkillServices;
  };
}

/**
 * Registers all security agent builder skills with the agentBuilder plugin
 */
export const registerSkills = async ({
  agentBuilder,
  experimentalFeatures,
  getStartServices,
  kibanaVersion,
  logger,
  ml,
  options,
}: RegisterSkillsOpts): Promise<void> => {
  await registerStaticSecuritySkills(agentBuilder, experimentalFeatures);
  await registerEndpointSecuritySkills(
    agentBuilder,
    experimentalFeatures,
    options.endpointAppContextService
  );

  const isEntityStoreV2Enabled = experimentalFeatures.entityAnalyticsEntityStoreV2;
  await agentBuilder.skills.register(
    getEntityAnalyticsSkill({ getStartServices, isEntityStoreV2Enabled, kibanaVersion, logger })
  );

  if (experimentalFeatures.dexAiSkillRecommendPrebuiltRules) {
    await agentBuilder.skills.register(
      createRecommendPrebuiltRulesSkill({ getStartServices, logger, ml })
    );
  }

  await agentBuilder.skills.register(
    findSecurityMlJobsSkill({ getStartServices, isEntityStoreV2Enabled, logger, ml })
  );

  if (experimentalFeatures.dexAiSkillFindRules) {
    await agentBuilder.skills.register(createFindRulesSkill({ getStartServices, logger }));
  }
};
