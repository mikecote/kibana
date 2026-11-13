/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    {
      modulePath: require.resolve('../task_types/anomaly_detection_alert.task'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/anomaly_detection_jobs_health.task'),
      exportName: 'taskType',
    },
  ],
  contributions: {
    embeddables: [
      { modulePath: require.resolve('../embeddable_contribution'), exportName: 'contribution' },
    ],
    'cases-attachment-types': [
      {
        modulePath: require.resolve('../task_types/case_attachment_type_contribution'),
        exportName: 'contribution',
      },
    ],
    'agent-builder': [
      {
        modulePath: require.resolve('../task_types/agent_builder_contribution'),
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
