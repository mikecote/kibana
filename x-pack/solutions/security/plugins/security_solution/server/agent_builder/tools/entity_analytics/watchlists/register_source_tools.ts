/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { ExperimentalFeatures } from '../../../../../common';
import type { SecurityWatchlistToolServices } from './services';
import { deleteWatchlistTool } from './delete_watchlist_tool';
import { setWatchlistRuleBasedDataSourceTool } from './set_watchlist_rule_based_data_source_tool';
import { removeWatchlistRuleBasedDataSourceTool } from './remove_watchlist_rule_based_data_source_tool';
import { listWatchlistDataSourcesTool } from './list_watchlist_data_sources_tool';

/** Registers tools that manage watchlists and their encrypted source credentials. */
export const registerWatchlistSourceTools = (
  agentBuilder: AgentBuilderPluginSetup,
  core: SecurityWatchlistToolServices,
  logger: Logger,
  experimentalFeatures: ExperimentalFeatures,
  hasEncryptionKey: boolean
): void => {
  agentBuilder.tools.register(
    deleteWatchlistTool(core, logger, experimentalFeatures, hasEncryptionKey)
  );
  agentBuilder.tools.register(
    setWatchlistRuleBasedDataSourceTool(core, logger, experimentalFeatures, hasEncryptionKey)
  );
  agentBuilder.tools.register(
    removeWatchlistRuleBasedDataSourceTool(core, logger, experimentalFeatures, hasEncryptionKey)
  );
  agentBuilder.tools.register(
    listWatchlistDataSourcesTool(core, logger, experimentalFeatures, hasEncryptionKey)
  );
};
