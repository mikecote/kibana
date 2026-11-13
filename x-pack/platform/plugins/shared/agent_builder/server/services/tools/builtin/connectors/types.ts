/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { AgentBuilderActionsStart } from '../../../actions_services';

/**
 * Options for creating connector tools.
 * Uses getters for lazy resolution — the actions and inference start contracts
 * are not available until after plugin start.
 */
export interface ConnectorToolsOptions {
  /** Lazy getter for the Actions plugin start contract (resolved at handler invocation time). */
  getActions: () => Promise<AgentBuilderActionsStart>;
  /** Lazy getter for the Inference plugin start contract (resolved at handler invocation time). */
  getInference: () => Promise<InferenceServerStart>;
}
