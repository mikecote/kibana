/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Logger, OnSetup } from '@kbn/core-di';
import { CoreSetup, CoreStart } from '@kbn/core-di-server';
import {
  backgroundTaskNodeType,
  BACKGROUND_TASK_NODE_SO_NAME,
} from '../saved_objects/background_task_node_type';
import type { BackgroundTaskNode } from '../saved_objects/schemas/background_task_node';
import { defineServiceModule, defineTaskType } from '../task_runtime/task_type';
import { savedObjectsModule } from '../task_runtime/saved_objects_module';

export const DELETE_INACTIVE_NODES_TASK_ID = 'delete_inactive_background_task_nodes';
export const DELETE_INACTIVE_NODES_TASK_TYPE = `task_manager:${DELETE_INACTIVE_NODES_TASK_ID}`;
export const CLEANUP_INTERVAL = '1m';
export const CLEANUP_LOOKBACK = '5m';

/** Registers the `background-task-node` type in a task process; Kibana registers it in setup. */
const backgroundTaskNodeModule = defineServiceModule({
  id: 'taskManager.backgroundTaskNode',
  requires: [savedObjectsModule],
  load: ({ bind }) => {
    bind(OnSetup).toResolvedValue(
      (savedObjects) => () => savedObjects.registerType(backgroundTaskNodeType),
      [CoreSetup('savedObjects')]
    );
  },
});

/** Removes the records of Kibana nodes that stopped reporting in. */
export const taskType = defineTaskType({
  type: DELETE_INACTIVE_NODES_TASK_TYPE,
  definition: {
    title: 'Remove inactive background task nodes',
  },
  requiresFakeRequest: false,
  modules: [backgroundTaskNodeModule],
  needs: { savedObjects: CoreStart('savedObjects'), logger: Logger },
  createRunner: ({ savedObjects, logger }) => ({
    async run() {
      const result = { state: {}, schedule: { interval: CLEANUP_INTERVAL } };
      try {
        const repository = savedObjects.createInternalRepository([BACKGROUND_TASK_NODE_SO_NAME]);
        const { saved_objects: inactiveNodes } = await repository.find<BackgroundTaskNode>({
          type: BACKGROUND_TASK_NODE_SO_NAME,
          perPage: 100,
          page: 1,
          filter: `${BACKGROUND_TASK_NODE_SO_NAME}.attributes.last_seen < now-${CLEANUP_LOOKBACK}`,
        });

        if (inactiveNodes.length > 0) {
          const nodesToDelete = inactiveNodes.map((node) => ({
            type: BACKGROUND_TASK_NODE_SO_NAME,
            id: node.attributes.id,
          }));
          await repository.bulkDelete(nodesToDelete, { force: true, refresh: false });
          logger.debug(
            `Inactive Kibana nodes: ${nodesToDelete.map(
              (node) => node.id
            )}, have been successfully deleted`
          );
        }
      } catch (e) {
        logger.error(`Deleting inactive nodes failed. Error: ${e.message} `);
      }
      return result;
    },
  }),
});
