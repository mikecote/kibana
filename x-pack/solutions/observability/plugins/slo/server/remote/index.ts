/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    { modulePath: require.resolve('../task_types/slo_burn_rate.task.ts'), exportName: 'taskType' },
  ],
  contributions: {
    embeddables: [
      { modulePath: require.resolve('../embeddable_contribution'), exportName: 'contribution' },
    ],
    'alerting-rule-read': [
      {
        modulePath: require.resolve('../task_types/rule_read_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/workflow_services_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
