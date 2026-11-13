/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export const remote = {
  taskTypes: [
    { modulePath: require.resolve('../task_types/workflow_run.task'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/workflow_resume.task'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/workflow_scheduled.task'),
      exportName: 'taskType',
    },
  ],
  contributions: {
    'task-scheduling': [
      {
        modulePath: require.resolve('../task_types/task_scheduling_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/fields_metadata_runtime_contribution'),
        exportName: 'contribution',
      },
      {
        modulePath: require.resolve('../task_types/data_views_runtime_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
