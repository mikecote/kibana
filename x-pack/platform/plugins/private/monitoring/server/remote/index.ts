/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  taskTypes: [
    { modulePath: require.resolve('../task_types/cluster_health.task.ts'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/license_expiration.task.ts'),
      exportName: 'taskType',
    },
    { modulePath: require.resolve('../task_types/cpu_usage.task.ts'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/missing_monitoring_data.task.ts'),
      exportName: 'taskType',
    },
    { modulePath: require.resolve('../task_types/disk_usage.task.ts'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/thread_pool_search_rejections.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/thread_pool_write_rejections.task.ts'),
      exportName: 'taskType',
    },
    { modulePath: require.resolve('../task_types/memory_usage.task.ts'), exportName: 'taskType' },
    { modulePath: require.resolve('../task_types/nodes_changed.task.ts'), exportName: 'taskType' },
    {
      modulePath: require.resolve('../task_types/logstash_version_mismatch.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/kibana_version_mismatch.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/elasticsearch_version_mismatch.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/ccr_read_exceptions.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/large_shard_size.task.ts'),
      exportName: 'taskType',
    },
  ],
} as const;
