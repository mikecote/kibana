/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { ExperimentalFeatures } from '../../../common';
import { entityRiskScoreTool } from './entity_analytics/entity_risk_score_tool';
import { attackDiscoverySearchTool } from './attack_discovery_search_tool';
import { securityLabsSearchTool } from './security_labs_search_tool';
import { alertsTool } from './alerts_tool';
import { buildRedirectUrlTool } from './build_redirect_url_tool';
import type { SecurityCoreToolServices } from './core_services';

/** Registers Security's search and navigation tools using their native scoped dependencies. */
export const registerSecurityCoreTools = (
  agentBuilder: AgentBuilderPluginSetup,
  core: SecurityCoreToolServices,
  logger: Logger,
  experimentalFeatures: ExperimentalFeatures
): void => {
  agentBuilder.tools.register(entityRiskScoreTool(core, logger));
  agentBuilder.tools.register(attackDiscoverySearchTool(core, logger));
  agentBuilder.tools.register(securityLabsSearchTool(core));
  agentBuilder.tools.register(alertsTool(core, logger));
  agentBuilder.tools.register(buildRedirectUrlTool(core, experimentalFeatures));
};
