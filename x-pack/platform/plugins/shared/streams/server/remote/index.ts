/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  contributions: {
    'agent-builder': [
      {
        modulePath: require.resolve('../task_types/agent_builder_contribution'),
        exportName: 'contribution',
      },
    ],
    'workflow-steps': [
      {
        modulePath: require.resolve('../task_types/fields_metadata_runtime_contribution'),
        exportName: 'contribution',
      },
      {
        modulePath: require.resolve('../task_types/workflow_services_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
