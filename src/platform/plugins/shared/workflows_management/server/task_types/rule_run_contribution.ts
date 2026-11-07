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

/** Registers the system connector with the management API of the executing workflow. */
export const contribution: RuleRunContribution = {
  register: ({ actions, alerting }, context) => {
    actions.registerType(
      getConnectorType(() => {
        if (!context.getService) {
          throw new Error(
            'Workflow execution services are required to execute the workflows connector'
          );
        }
        return context.getService<WorkflowsManagementApi>('workflows.management');
      }) as never
    );
    alerting.registerConnectorAdapter(getWorkflowsConnectorAdapter());
  },
};
