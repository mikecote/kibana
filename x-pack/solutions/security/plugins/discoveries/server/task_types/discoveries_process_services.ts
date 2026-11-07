/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRuleDataClient } from '@kbn/rule-registry-plugin/server';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import type { registerWorkflowSteps } from '../workflows/register_workflow_steps';

export const DISCOVERIES_PROCESS_SERVICES_ID = 'discoveries.runtime';

export type DiscoveriesProcessServices = Parameters<typeof registerWorkflowSteps>[1] & {
  adhocAttackDiscoveryDataClient: IRuleDataClient;
  workflowsManagementApi: WorkflowsManagementApi;
};
