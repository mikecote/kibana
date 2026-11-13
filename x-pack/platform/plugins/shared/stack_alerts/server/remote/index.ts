/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    { modulePath: require.resolve('../task_types/es_query.task'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/index_threshold.task'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/geo_containment.task'),
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
  },
} as const;
