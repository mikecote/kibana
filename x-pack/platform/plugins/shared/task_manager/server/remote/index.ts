/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const remote = {
  capabilities: {
    Initialization: {
      token: 'taskManager.InitializationApi',
      placement: 'coordinator',
      scope: 'worker',
      needs: [],
      modulePath: require.resolve('../task_process/initialization_api'),
      exportName: 'InitializationApi',
    },
    CoordinatorRequest: {
      token: 'taskManager.CoordinatorRequest',
      placement: 'coordinator',
      scope: 'run',
      needs: [],
      modulePath: require.resolve('../task_process/coordinator_request'),
      exportName: 'CoordinatorRequestToken',
    },
    TaskPool: {
      token: 'taskManager.TaskPoolApi',
      placement: 'coordinator',
      scope: 'run',
      needs: [],
      modulePath: require.resolve('../task_process/task_pool_api'),
      exportName: 'TaskPoolApi',
    },
    RunProgress: {
      token: 'taskManager.RunProgressApi',
      placement: 'coordinator',
      scope: 'run',
      needs: [],
      modulePath: require.resolve('../task_process/run_progress_api'),
      exportName: 'RunProgressApi',
    },
    RunCoordinator: {
      token: 'taskManager.RunCoordinator',
      placement: 'coordinator',
      scope: 'run',
      needs: ['taskManager.TaskPoolApi', 'taskManager.RunProgressApi'],
      modulePath: require.resolve('../task_process/run_coordinator'),
      exportName: 'RunCoordinator',
    },
    RunCancellation: {
      token: 'taskManager.RunCancellation',
      placement: 'executor',
      scope: 'run',
      needs: [],
      modulePath: require.resolve('../task_process/run_cancellation'),
      exportName: 'RunCancellation',
    },
  },
  taskTypes: [
    {
      modulePath: require.resolve('../task_types/delete_inactive_nodes.task.ts'),
      exportName: 'taskType',
    },
    {
      modulePath: require.resolve('../task_types/mark_removed_tasks_as_unrecognized.task.ts'),
      exportName: 'taskType',
    },
  ],
} as const;
