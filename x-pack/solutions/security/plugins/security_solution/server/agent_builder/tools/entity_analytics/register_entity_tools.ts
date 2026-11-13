/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { ExperimentalFeatures } from '../../../../common';
import type { ProductFeaturesReader } from '../../../lib/product_features_service';
import type { SecurityEntityToolServices } from './entity_services';
import {
  getEntityGraphTool,
  getEntityRiskScoreHistoryTool,
  entityRelationshipHistoryTool,
  createWatchlistTool,
  listWatchlistsTool,
  getWatchlistIdTool,
  updateWatchlistTool,
  addEntitiesToWatchlistTool,
  removeEntitiesFromWatchlistTool,
  searchEntitiesTool,
  setAssetCriticalityTool,
  getResolutionGroupTool,
  linkEntitiesTool,
  unlinkEntitiesTool,
  listResolutionRulesTool,
  setResolutionRulesTool,
  listLeadsTool,
  dismissLeadTool,
} from '.';

/** Registers entity tools over the owning authorization, entity and watchlist clients. */
export const registerSecurityEntityTools = (
  agentBuilder: AgentBuilderPluginSetup,
  core: SecurityEntityToolServices,
  logger: Logger,
  experimentalFeatures: ExperimentalFeatures,
  productFeatures: ProductFeaturesReader,
  kibanaVersion: string
): void => {
  agentBuilder.tools.register(
    getEntityGraphTool(core, logger, experimentalFeatures, productFeatures)
  );
  agentBuilder.tools.register(
    getEntityRiskScoreHistoryTool(core, logger, experimentalFeatures, kibanaVersion)
  );
  agentBuilder.tools.register(entityRelationshipHistoryTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(createWatchlistTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(listWatchlistsTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(getWatchlistIdTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(updateWatchlistTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(addEntitiesToWatchlistTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(removeEntitiesFromWatchlistTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(searchEntitiesTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(
    setAssetCriticalityTool(core, logger, experimentalFeatures, kibanaVersion)
  );
  agentBuilder.tools.register(getResolutionGroupTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(linkEntitiesTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(unlinkEntitiesTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(listResolutionRulesTool(core, logger, experimentalFeatures));
  agentBuilder.tools.register(setResolutionRulesTool(core, logger, experimentalFeatures));
  if (experimentalFeatures.leadGenerationEnabled) {
    agentBuilder.tools.register(listLeadsTool(core, logger, experimentalFeatures));
    agentBuilder.tools.register(dismissLeadTool(core, logger, experimentalFeatures));
  }
};
