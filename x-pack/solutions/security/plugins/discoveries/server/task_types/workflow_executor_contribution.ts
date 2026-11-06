/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AttackDiscoveryWorkflowExecutorContribution } from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import { AD_STEP_TYPE_IDS } from '../../common/step_types';
import { createAttackDiscoveryWorkflowExecutor } from '../lib/schedules/workflow_executor/create_attack_discovery_workflow_executor';

/**
 * What the attack discovery rule type needs of this plugin in a task process: the executor of the
 * rules that run workflows, which this plugin builds from explicit dependencies for Kibana as well.
 */
export const contribution: AttackDiscoveryWorkflowExecutorContribution = {
  stepTypeIds: AD_STEP_TYPE_IDS,
  createWorkflowExecutor: createAttackDiscoveryWorkflowExecutor,
};
