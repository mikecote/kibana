/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { ExperimentalFeatures } from '../../../common/experimental_features';
import { getDetectionRuleEditSkill } from './detection_rule_edit';
import { manageWatchlistsSkill } from './manage_watchlists';
import { manageResolutionSkill } from './entity_resolution';
import { pciComplianceSkill } from './pci_compliance';
import { threatHuntingSkill } from './threat_hunting';
import { alertAnalysisSkill } from './alert_analysis';
import { alertTriageSkill } from './alert_triage';
import { createInvestigateRuleSkill } from './investigate_rule';
import { siemReadinessSkill } from './siem_readiness';
import {
  automaticMigrationRulesStartMigrationSkill,
  automaticMigrationRulesSummarizeSkill,
  automaticMigrationRulesStopMigrationSkill,
  automaticMigrationRulesUpdateMigrationSkill,
  automaticMigrationRulesDeleteMigrationSkill,
  automaticMigrationRulesUpdateTranslatedRuleSkill,
  automaticMigrationRulesInstallRulesSkill,
} from './siem_migration';
import { entityAnalyticsLeadsSkill } from './entity_analytics_leads';
import { createDetectionCoverageSkill } from './detection_coverage';
import { endpointForensicAnalysisSkill } from './endpoint_forensic_analysis';
import { SIEM_READINESS_AGENT_BUILDER_ENABLED } from '../siem_readiness_feature_flag';

/** Registers Security skills whose definitions depend only on feature flags. */
export const registerStaticSecuritySkills = async (
  agentBuilder: Pick<AgentBuilderPluginSetup, 'skills'>,
  experimentalFeatures: ExperimentalFeatures
): Promise<void> => {
  if (experimentalFeatures.entityAnalyticsWatchlistEnabled) {
    await agentBuilder.skills.register(manageWatchlistsSkill);
  }

  if (experimentalFeatures.entityAnalyticsEntityStoreV2) {
    await agentBuilder.skills.register(manageResolutionSkill);
  }

  await agentBuilder.skills.register(
    getDetectionRuleEditSkill({
      rulePreviewEnabled: experimentalFeatures.rulePreviewAttachmentEnabled,
    })
  );

  await agentBuilder.skills.register(createDetectionCoverageSkill());

  await agentBuilder.skills.register(threatHuntingSkill);
  await agentBuilder.skills.register(alertAnalysisSkill);
  await agentBuilder.skills.register(alertTriageSkill);

  if (SIEM_READINESS_AGENT_BUILDER_ENABLED) {
    await agentBuilder.skills.register(siemReadinessSkill);
  }

  // Automatic Migration sibling skills: gated by the Automatic Migration feature flag and the
  // dedicated agent-builder experimental flag, so skills ship in lockstep with their tools.
  if (
    !experimentalFeatures.siemMigrationsDisabled &&
    experimentalFeatures.siemRuleMigrationsAgentBuilderEnabled
  ) {
    await agentBuilder.skills.register(automaticMigrationRulesSummarizeSkill);
    await agentBuilder.skills.register(automaticMigrationRulesStartMigrationSkill);
    await agentBuilder.skills.register(automaticMigrationRulesStopMigrationSkill);
    await agentBuilder.skills.register(automaticMigrationRulesUpdateMigrationSkill);
    await agentBuilder.skills.register(automaticMigrationRulesDeleteMigrationSkill);
    await agentBuilder.skills.register(automaticMigrationRulesUpdateTranslatedRuleSkill);
    await agentBuilder.skills.register(automaticMigrationRulesInstallRulesSkill);
  }

  if (experimentalFeatures.leadGenerationEnabled) {
    await agentBuilder.skills.register(entityAnalyticsLeadsSkill);
  }

  if (experimentalFeatures.pciComplianceAgentBuilder) {
    await agentBuilder.skills.register(pciComplianceSkill);
  }

  if (experimentalFeatures.endpointForensicAnalysisSkill) {
    await agentBuilder.skills.register(endpointForensicAnalysisSkill);
  }

  if (experimentalFeatures.investigateRuleSkill) {
    await agentBuilder.skills.register(createInvestigateRuleSkill());
  }
};
