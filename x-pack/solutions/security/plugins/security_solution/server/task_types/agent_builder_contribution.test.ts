/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { registerSiemReadinessTools } from '../agent_builder/tools/siem_readiness';
import { SIEM_READINESS_AGENT_BUILDER_ENABLED } from '../agent_builder/siem_readiness_feature_flag';
import { generateLeadsTool } from '../agent_builder/tools/entity_analytics/leads/generate_leads_tool';
import { registerSkills } from '../agent_builder/skills/register_skills';
import { registerWatchlistSourceTools } from '../agent_builder/tools/entity_analytics/watchlists/register_source_tools';
import { createDetectionRuleTool } from '../agent_builder/tools/create_detection_rule_tool';
import { getEntityTool } from '../agent_builder/tools/entity_analytics/get_entity_tool';
import { registerAttachments } from '../agent_builder/attachments/register_attachments';
import { registerSecurityCoreTools } from '../agent_builder/tools/register_core_tools';
import { registerSecurityAssessmentTools } from '../agent_builder/tools/register_assessment_tools';
import { registerSecurityEntityTools } from '../agent_builder/tools/entity_analytics/register_entity_tools';
import { createNativeProductFeaturesReader } from '../lib/product_features_service';
import { createMockConfig } from '../config.mock';
import { contribution } from './agent_builder_contribution';
import {
  SECURITY_AGENT_BUILDER_SETTINGS_ID,
  type SecurityAgentBuilderSettings,
} from './agent_builder_settings';

it.each([true, false])(
  'matches Main shared Security registrations with conditional features %s',
  async (enabled) => {
    const logger = loggerMock.create();
    const config = createMockConfig();
    config.experimentalFeatures = {
      ...config.experimentalFeatures,
      riskScoreHistoryEnabled: enabled,
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
            registerSecurityCoreTools(agentBuilder, core, logger, config.experimentalFeatures);
            registerSecurityAssessmentTools(
              agentBuilder,
              core,
              logger,
              config.experimentalFeatures,
              createNativeProductFeaturesReader(snapshot.productFeatures)
            );
            registerSecurityEntityTools(
              agentBuilder,
              core,
              logger,
              config.experimentalFeatures,
              createNativeProductFeaturesReader(snapshot.productFeatures),
              '1.0.0'
            );
            registerWatchlistSourceTools(
              agentBuilder,
              core,
              logger,
              config.experimentalFeatures,
              snapshot.canEncrypt
            );
            agentBuilder.tools.register(
              createDetectionRuleTool(core, logger, config.experimentalFeatures)
            );
            agentBuilder.tools.register(
              getEntityTool(core, logger, undefined, config.experimentalFeatures)
            );
            if (SIEM_READINESS_AGENT_BUILDER_ENABLED)
              registerSiemReadinessTools(agentBuilder, core, logger, snapshot.isServerless);
            if (config.experimentalFeatures.leadGenerationEnabled)
              agentBuilder.tools.register(
                generateLeadsTool(
                  core,
                  logger,
                  config.experimentalFeatures,
                  core.getStartServices,
                  undefined
                )
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
