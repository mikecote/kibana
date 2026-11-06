/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DefaultAlertRetrievalStepTypeId } from './default_alert_retrieval_step';
import { DefaultValidationStepTypeId } from './default_validation_step';
import { GenerateStepTypeId } from './generate_step';
import { PersistDiscoveriesStepTypeId } from './persist_discoveries_step';
import { RunStepTypeId } from './run_step';

/**
 * The step types the discoveries plugin registers with the workflows extensions: each is registered
 * when the `securitySolution.attackDiscoveryWorkflowsEnabled` feature flag is on. A task process
 * that does not have the plugin's registry answers `hasStepDefinition` from this set and the flag.
 */
export const AD_STEP_TYPE_IDS: ReadonlySet<string> = new Set([
  DefaultAlertRetrievalStepTypeId,
  DefaultValidationStepTypeId,
  GenerateStepTypeId,
  PersistDiscoveriesStepTypeId,
  RunStepTypeId,
]);
