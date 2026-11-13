/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  contributions: {
    embeddables: [
      { modulePath: require.resolve('../embeddable_contribution'), exportName: 'contribution' },
    ],
    'agent-builder': [
      {
        modulePath: require.resolve('../task_types/agent_builder_contribution'),
        exportName: 'contribution',
      },
    ],
  },
} as const;
