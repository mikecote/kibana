/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { config as fleetConfig } from '@kbn/fleet-plugin/server/config';
import { ConfigSchema as listsConfigSchema } from '@kbn/lists-plugin/server/config';
import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server/config';
import { createMockConfig } from '../config.mock';
import { getTaskProcessSettings, TASK_PROCESS_SETTINGS_ID } from '../config';
import { SECURITY_AGENT_BUILDER_SETTINGS_ID } from './agent_builder_settings';
import type { SecurityAgentBuilderSettings } from './agent_builder_settings';

/** Supplies representative complete dispatch data for the cross-plugin process tests. */
export const createSecurityAgentBuilderExampleSettings = (): Record<string, object> => {
  const base = createMockConfig();
  const config = {
    ...base,
    experimentalFeatures: {
      ...base.experimentalFeatures,
      entityAnalyticsEntityStoreV2: true,
      entityAnalyticsWatchlistEnabled: true,
      automaticTroubleshootingSkill: true,
      elasticDefendPolicyManagementSkill: true,
      endpointResponseActionsSkill: true,
      endpointForensicAnalysisSkill: true,
      dexAiSkillRecommendPrebuiltRules: true,
      dexAiSkillFindRules: true,
      aiRuleCreationEnabled: true,
      investigateRuleSkill: true,
      riskScoreHistoryEnabled: true,
      rulePreviewAttachmentEnabled: true,
      leadGenerationEnabled: true,
      pciComplianceAgentBuilder: true,
      siemMigrationsDisabled: false,
      siemRuleMigrationsAgentBuilderEnabled: true,
    },
  };
  const snapshot: SecurityAgentBuilderSettings = {
    config,
    productFeatures: { enabledProductFeatureKeys: [], registeredActions: [] },
    isServerless: false,
    canEncrypt: true,
    cpsAvailable: false,
    plugins: {
      ml: true,
      lists: true,
      security: true,
      osquery: true,
      llmTasks: true,
      fleet: true,
      mitreAttack: true,
    },
  };
  return {
    [SECURITY_AGENT_BUILDER_SETTINGS_ID]: snapshot,
    [TASK_PROCESS_SETTINGS_ID]: getTaskProcessSettings(config),
    alerting: alertingConfigSchema.validate({}),
    ruleRegistry: ruleRegistryConfig.schema.validate({}),
    lists: listsConfigSchema.validate({}),
    entityStoreRuntime: { maintainers: [] },
    mlWorkflowRuntime: {
      moduleFiles: {},
      enabledFeatures: { ad: true, dfa: true, nlp: true },
      compatibleModuleType: null,
      spacesEnabled: true,
      cpsEnabled: false,
      cloud: { isInTrial: false },
    },
    fleetPackageMetadata: {
      config: fleetConfig.schema.validate({}),
      assets: { bundledPackages: [] },
      elasticConnectorsServerlessEnabled: false,
      kibanaBranch: 'main',
      isProductionMode: false,
      isFipsEnabled: false,
    },
    dataViewsRuntime: {
      scriptedFieldsEnabled: false,
      rollupsEnabled: false,
      dataTiersExcludedForFields: true,
      fieldListCachingEnabled: true,
    },
    dataSearchRuntime: {
      multiSearchDocLink: coreMock.createSetup().docLinks.links.apis.multiSearch,
      search: {
        searchConfig: searchConfigSchema.validate({}),
        uiSettingsValidationsEnabled: false,
        elasticsearchTimeouts: { shardTimeout: 30000, requestTimeout: 30000 },
        rollupsEnabled: false,
      },
      docLinks: coreMock.createSetup().docLinks,
    },
  };
};
