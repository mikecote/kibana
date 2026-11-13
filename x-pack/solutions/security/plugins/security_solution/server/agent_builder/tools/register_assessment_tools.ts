/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { ExperimentalFeatures } from '../../../common';
import type { ProductFeaturesReader } from '../../lib/product_features_service';
import type { SecurityAccessToolServices } from './access_services';
import { pciComplianceTool } from './pci_compliance_tool';
import { pciScopeDiscoveryTool } from './pci_scope_discovery_tool';
import { pciFieldMapperTool } from './pci_field_mapper_tool';
import { registerSiemMigrationTools } from './siem_migrations';

/** Registers assessment and migration tools with Main's feature and product gates. */
export const registerSecurityAssessmentTools = (
  agentBuilder: AgentBuilderPluginSetup,
  core: SecurityAccessToolServices,
  logger: Logger,
  experimentalFeatures: ExperimentalFeatures,
  productFeatures: ProductFeaturesReader
): void => {
  if (experimentalFeatures.pciComplianceAgentBuilder) {
    agentBuilder.tools.register(pciScopeDiscoveryTool(core, logger));
    agentBuilder.tools.register(pciComplianceTool(core, logger));
    agentBuilder.tools.register(pciFieldMapperTool(core, logger));
  }
  if (
    !experimentalFeatures.siemMigrationsDisabled &&
    experimentalFeatures.siemRuleMigrationsAgentBuilderEnabled
  ) {
    registerSiemMigrationTools(agentBuilder, core, productFeatures, logger);
  }
};
