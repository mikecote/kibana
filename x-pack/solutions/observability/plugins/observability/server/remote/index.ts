/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    {
      modulePath: require.resolve('../task_types/custom_threshold.task'),
      exportName: 'taskType',
    },
  ],
  contributions: {
    'alerting-rule-read': [
      {
        modulePath: require.resolve('../task_types/rule_read_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/workflow_ui_settings_contribution'),
        exportName: 'contribution',
      },
    ],
    'cases-attachment-types': [
      {
        modulePath: require.resolve('../task_types/case_attachment_type_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
