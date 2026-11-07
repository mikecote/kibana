/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EncryptedSavedObjectsClient } from '@kbn/encrypted-saved-objects-plugin/server';
import { SavedObjectsErrorHelpers } from '@kbn/core-saved-objects-server';
import type { TaskManagerStartContract } from '../../plugin';
import { TaskStore } from '../../task_store';
import type { StoreOpts } from '../../task_store';
import { TaskScheduling } from '../../task_scheduling';
import type { TaskSchedulingOpts } from '../../task_scheduling';
import { removeIfExists } from '../../lib/remove_if_exists';

export { TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS } from '../../task_encryption';

export type HostTaskManager = Pick<
  TaskManagerStartContract,
  | 'schedule'
  | 'bulkSchedule'
  | 'bulkUpdateSchedules'
  | 'aggregate'
  | 'get'
  | 'bulkGet'
  | 'fetch'
  | 'remove'
  | 'removeIfExists'
  | 'bulkRemove'
  | 'runSoon'
  | 'ensureScheduled'
>;

export interface HostTaskSchedulingOptions {
  store: StoreOpts;
  scheduling: Omit<TaskSchedulingOpts, 'taskStore' | 'definitions' | 'logger' | 'taskManagerId'>;
  allowedTypes: RegExp;
  onRunEnd?: (flusher: () => Promise<void>) => void;
  encryption?: {
    client: EncryptedSavedObjectsClient;
    isEncryptionError: (error: Error) => boolean;
  };
}

/** Lends native TaskStore and TaskScheduling operations within the module's declared write scope. */
export const createHostTaskScheduling = ({
  store: storeOptions,
  scheduling: schedulingOptions,
  allowedTypes,
  encryption,
  onRunEnd,
}: HostTaskSchedulingOptions): HostTaskManager => {
  const store = new TaskStore(storeOptions);
  if (encryption)
    store.registerEncryptedSavedObjectsClient(encryption.client, encryption.isEncryptionError);
  const scheduling = new TaskScheduling({
    ...schedulingOptions,
    taskStore: store,
    definitions: storeOptions.definitions,
    logger: storeOptions.logger,
    taskManagerId: storeOptions.taskManagerId,
  });
  onRunEnd?.(() => scheduling.flushClaimNudges());
  const assertAllowedType = (type: string, operation: string = 'scheduled'): void => {
    if (!allowedTypes.test(type))
      throw new Error(`Task type ${type} cannot be ${operation} from a task process`);
  };
  const assertAllowedTask = async (id: string, operation: string): Promise<void> => {
    assertAllowedType((await store.get(id)).taskType, operation);
  };
  const assertAllowedTasks = async (ids: string[], operation: string): Promise<void> => {
    for (const result of await store.bulkGet(ids)) {
      if (result.tag === 'ok') assertAllowedType(result.value.taskType, operation);
      else if (result.error.error.statusCode !== 404) throw new Error(result.error.error.message);
    }
  };
  return {
    schedule: async (task, options) => {
      assertAllowedType(task.taskType);
      return scheduling.schedule(task, options);
    },
    bulkSchedule: async (tasks, options) => {
      tasks.forEach(({ taskType }) => assertAllowedType(taskType));
      return scheduling.bulkSchedule(tasks, options);
    },
    ensureScheduled: async (task, options) => {
      assertAllowedType(task.taskType);
      return scheduling.ensureScheduled(task, options);
    },
    runSoon: async (id, options) => {
      await assertAllowedTask(id, 'run soon');
      return scheduling.runSoon(id, options);
    },
    bulkUpdateSchedules: async (ids, schedule, options) => {
      await assertAllowedTasks(ids, 'rescheduled');
      return scheduling.bulkUpdateSchedules(ids, schedule, options);
    },
    get: (id) => store.get(id),
    bulkGet: (ids) => store.bulkGet(ids),
    fetch: (options) => store.fetch(options),
    aggregate: (options) => store.aggregate(options),
    remove: async (id) => {
      await assertAllowedTask(id, 'removed');
      return store.remove(id);
    },
    removeIfExists: async (id) => {
      try {
        await assertAllowedTask(id, 'removed');
      } catch (error) {
        if (SavedObjectsErrorHelpers.isNotFoundError(error)) return;
        throw error;
      }
      return removeIfExists(store, id);
    },
    bulkRemove: async (ids) => {
      await assertAllowedTasks(ids, 'removed');
      return store.bulkRemove(ids);
    },
  };
};
