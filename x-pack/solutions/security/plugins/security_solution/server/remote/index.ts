/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    { modulePath: require.resolve('../task_types/eql.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/esql.task.ts'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/indicator_match.task.ts'),
      exportName: 'taskType',
    },
    { modulePath: require.resolve('../task_types/ml.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/new_terms.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/query.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/saved_query.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/threshold.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/notifications.task.ts'), exportName: 'taskType' },
  ],
  contributions: {
    'agent-builder': [
      {
        modulePath: require.resolve('../task_types/agent_builder_contribution'),
        exportName: 'contribution',
      },
    ],
    'alerting-rule-read': [
      {
        modulePath: require.resolve('../task_types/rule_read_contribution'),
        exportName: 'contribution',
      },
    ],
    'cases-client': [
      {
        modulePath: require.resolve('../task_types/cases_client_contribution'),
        exportName: 'contribution',
      },
    ],
    'cases-attachment-types': [
      {
        modulePath: require.resolve('../task_types/case_attachment_type_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/workflow_steps_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
