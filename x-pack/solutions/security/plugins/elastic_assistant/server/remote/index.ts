/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    {
      modulePath: require.resolve('../task_types/attack_discovery.task'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/attack_discovery_data_generator.task'),
      exportName: 'taskType',
    },
  ],
} as const;
