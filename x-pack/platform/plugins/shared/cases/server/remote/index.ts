/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  capabilities: {
    CasesOperations: {
      token: 'cases.CasesOperations',
      placement: 'coordinator',
      scope: 'run',
      needs: ['taskManager.CoordinatorRequest'],
      modulePath: require.resolve('../task_types/cases_operations'),
      exportName: 'defineCasesOperations',
    },
  },
  contributions: {
    'agent-builder': [
      {
        modulePath: require.resolve('../task_types/agent_builder_contribution'),
        exportName: 'contribution',
      },
    ],
    'alerting-rule-run': [
      {
        modulePath: require.resolve('../task_types/rule_run_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/coordinator_workflow_steps_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
