/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { ExperimentalFeatures } from '../../../common';
import { registerWatchlistSourceTools } from './entity_analytics/watchlists/register_source_tools';
import { registerSecurityCoreTools } from './register_core_tools';
import { registerSecurityAssessmentTools } from './register_assessment_tools';
import { registerSecurityEntityTools } from './entity_analytics/register_entity_tools';
import { getEntityTool, generateLeadsTool } from './entity_analytics';
import { createDetectionRuleTool } from './create_detection_rule_tool';
import { registerSiemReadinessTools } from './siem_readiness';
import { runRulePreviewTool } from './run_rule_preview_tool';
import type { RulePreviewExecutionDeps } from '../../lib/detection_engine/rule_preview/api/preview_rules/run_rule_preview';
import type { SecurityToolServices } from './services';
import type { EntityAnalyticsMlServices } from '../../lib/entity_analytics/ml_anomaly_detection/ml_services';
import type { ProductFeaturesReader } from '../../lib/product_features_service';
import { SIEM_READINESS_AGENT_BUILDER_ENABLED } from '../siem_readiness_feature_flag';

/**
 * Registers all security agent builder tools with the agentBuilder plugin.
 *
 * PCI compliance tools are gated behind `experimentalFeatures.pciComplianceAgentBuilder` and the
 * `run_rule_preview` tool behind `experimentalFeatures.rulePreviewAttachmentEnabled` so the
 * features can ship dark and be enabled per environment.
 */
export const registerTools = (
  agentBuilder: AgentBuilderPluginSetup,
  core: SecurityToolServices,
  logger: Logger,
  experimentalFeatures: ExperimentalFeatures,
  productFeaturesService: ProductFeaturesReader,
  ml: EntityAnalyticsMlServices | undefined,
  rulePreviewDeps: RulePreviewExecutionDeps,
  isServerless: boolean = false,
  kibanaVersion: string,
  hasEncryptionKey: boolean = false
) => {
  registerSecurityCoreTools(agentBuilder, core, logger, experimentalFeatures);
  registerSecurityAssessmentTools(
    agentBuilder,
    core,
    logger,
    experimentalFeatures,
    productFeaturesService
  );
  registerSecurityEntityTools(
    agentBuilder,
    core,
    logger,
    experimentalFeatures,
    productFeaturesService,
    kibanaVersion
  );
  agentBuilder.tools.register(createDetectionRuleTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(getEntityTool(core, logger, ml, experimentalFeatures));
  registerWatchlistSourceTools(agentBuilder, core, logger, experimentalFeatures, hasEncryptionKey);

  if (experimentalFeatures.rulePreviewAttachmentEnabled) {
    agentBuilder.tools.register(runRulePreviewTool(rulePreviewDeps));
  }

  if (experimentalFeatures.leadGenerationEnabled) {
    agentBuilder.tools.register(
      generateLeadsTool(core, logger, experimentalFeatures, core.getStartServices, ml)
    );
  }

  if (SIEM_READINESS_AGENT_BUILDER_ENABLED) {
    registerSiemReadinessTools(agentBuilder, core, logger, isServerless);
  }
};
