/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { CoreStart } from '@kbn/core-lifecycle-server';
import { registerTaskType } from '../task_runtime';
import type { TaskManagerPluginsStart } from '../plugin';
import type { TaskScheduling } from '../task_scheduling';
import type { TaskTypeDictionary } from '../task_type_dictionary';
import type { TaskManagerStartContract } from '..';
import {
  CLEANUP_INTERVAL,
  DELETE_INACTIVE_NODES_TASK_ID as TASK_ID,
  DELETE_INACTIVE_NODES_TASK_TYPE as TASK_TYPE,
  taskType,
} from '../task_types/delete_inactive_nodes.task';

export { CLEANUP_INTERVAL, CLEANUP_LOOKBACK } from '../task_types/delete_inactive_nodes.task';

export async function scheduleDeleteInactiveNodesTaskDefinition(
  logger: Logger,
  taskScheduling: TaskScheduling
) {
  try {
    await taskScheduling.ensureScheduled({
      id: TASK_ID,
      taskType: TASK_TYPE,
      schedule: {
        interval: CLEANUP_INTERVAL,
      },
      state: {},
      params: {},
    });
  } catch (e) {
    logger.error(`Error scheduling ${TASK_ID} task, received ${e.message}`);
  }
}

export function registerDeleteInactiveNodesTaskDefinition(
  logger: Logger,
  coreStartServices: () => Promise<[CoreStart, TaskManagerPluginsStart, TaskManagerStartContract]>,
  taskTypeDictionary: TaskTypeDictionary
) {
  registerTaskType(taskTypeDictionary, taskType, {
    resolve: async () => {
      const [{ savedObjects }] = await coreStartServices();
      return { savedObjects, logger };
    },
  });
}

/** The task's runner factory with Kibana's services, for callers that run it directly. */
export function taskRunner(
  logger: Logger,
  coreStartServices: () => Promise<[CoreStart, TaskManagerPluginsStart, TaskManagerStartContract]>
) {
  return () => ({
    async run() {
      const [{ savedObjects }] = await coreStartServices();
      return taskType.createRunner({ savedObjects, logger }, {} as never).run();
    },
  });
}
