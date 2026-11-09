/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { registerTools } from '../agent_builder/tools/register_tools';
import { loggerMock } from '@kbn/logging-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { registerSkills } from '../agent_builder/skills/register_skills';
import { registerAttachments } from '../agent_builder/attachments/register_attachments';
import { createNativeProductFeaturesReader } from '../lib/product_features_service';
import { createMockConfig } from '../config.mock';
import { contribution } from './agent_builder_contribution';
import {
  SECURITY_AGENT_BUILDER_SETTINGS_ID,
  type SecurityAgentBuilderSettings,
} from './agent_builder_settings';

it.each([true, false])(
  'matches every Main Security registration with conditional features %s',
  async (enabled) => {
    const logger = loggerMock.create();
    const config = createMockConfig();
    config.experimentalFeatures = {
      ...config.experimentalFeatures,
      riskScoreHistoryEnabled: enabled,
      entityAnalyticsEntityStoreV2: enabled,
      entityAnalyticsWatchlistEnabled: enabled,
      automaticTroubleshootingSkill: enabled,
      elasticDefendPolicyManagementSkill: enabled,
      endpointResponseActionsSkill: enabled,
      dexAiSkillRecommendPrebuiltRules: enabled,
      dexAiSkillFindRules: enabled,
      aiRuleCreationEnabled: enabled,
      investigateRuleSkill: enabled,
      endpointForensicAnalysisSkill: enabled,
      rulePreviewAttachmentEnabled: enabled,
      siemMigrationsDisabled: !enabled,
      siemRuleMigrationsAgentBuilderEnabled: enabled,
      leadGenerationEnabled: enabled,
      pciComplianceAgentBuilder: enabled,
    };
    const snapshot: SecurityAgentBuilderSettings = {
      config,
      productFeatures: { enabledProductFeatureKeys: [], registeredActions: [] },
      isServerless: false,
      canEncrypt: true,
      cpsAvailable: false,
      plugins: { ml: false, security: true, osquery: false },
    };
    const main = await collectRegisteredIds({
      contributions: [
        {
          register: async (agentBuilder) => {
            const core = {
              getStartServices: async () => {
                throw new Error('Attachment registration must not open execution services');
              },
            };
            registerTools(
              agentBuilder,
              core,
              logger,
              config.experimentalFeatures,
              createNativeProductFeaturesReader(snapshot.productFeatures),
              undefined,
              {
                config,
                ml: undefined,
                security: undefined,
                getStartServices: core.getStartServices,
                logger,
                isServerless: snapshot.isServerless,
                getPreviewRunServices: async () => {
                  throw new Error('Registration must not initialize preview services');
                },
              },
              snapshot.isServerless,
              '1.0.0',
              snapshot.canEncrypt
            );
            await registerSkills({
              agentBuilder,
              experimentalFeatures: config.experimentalFeatures,
              getStartServices: core.getStartServices,
              kibanaVersion: '1.0.0',
              logger,
              ml: undefined,
              options: {
                endpointAppContextService: async () => {
                  throw new Error('Registration must not initialize Endpoint');
                },
              },
            });
            await registerAttachments(agentBuilder, core, logger, config.experimentalFeatures);
          },
        },
      ],
      settings: {},
      logger,
    });
    const native = await collectRegisteredIds({
      contributions: [contribution],
      settings: { [SECURITY_AGENT_BUILDER_SETTINGS_ID]: snapshot },
      logger,
    });
    expect(native).toEqual(main);
    expect(native.attachmentTypes).toContain('security.rule');
  }
);
