/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { RuleRunContribution } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import type { WorkflowsManagementApi } from '../api/workflows_management_api';
import { getConnectorType, getWorkflowsConnectorAdapter } from '../connectors/workflows';

/**
 * The `.workflows` system action and its adapter, so a rule run can enqueue the workflows it was
 * configured with. Running them is Kibana's job when it executes the enqueued action, which is why
 * the connector type here has no API behind it.
 */
export const contribution: RuleRunContribution = {
  register: ({ actions, alerting }) => {
    actions.registerType(getConnectorType({} as WorkflowsManagementApi) as never);
    alerting.registerConnectorAdapter(getWorkflowsConnectorAdapter());
  },
};
