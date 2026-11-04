/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 } from 'uuid';
import { omit } from 'lodash';
import type { estypes } from '@elastic/elasticsearch';
import type { Logger } from '@kbn/logging';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import type { ISavedObjectsRepository } from '@kbn/core-saved-objects-api-server';
import type { ConcreteTaskInstance, TaskInstance } from '../../task';
import { TaskStatus } from '../../task';
import { TASK_MANAGER_INDEX } from '../../constants';
import { ensureDeprecatedFieldsAreCorrected } from '../../lib/correct_deprecated_fields';
import { getFirstRunAt } from '../../lib/get_first_run_at';
import { parseIntervalAsMillisecond } from '../../lib/intervals';
import {
  savedObjectToConcreteTaskInstance,
  taskInstanceToAttributes,
} from '../../lib/task_instance_serialization';
import type { TaskHost } from '../../task_type_module';

const TASK_SO_NAME = 'task';

const addJitter = (interval?: string): { runAt: Date; scheduledAt: Date } => {
  // Adhoc tasks run immediately.
  if (!interval) return { runAt: new Date(), scheduledAt: new Date() };
  const now = Date.now();
  const maximumOffsetTimestamp = now + 1000 * 60 * 5; // now + 5 minutes
  const maximumRunAt = Math.min(now + parseIntervalAsMillisecond(interval), maximumOffsetTimestamp);
  const runAt = new Date(now + Math.floor(Math.random() * (maximumRunAt - now) + 1));
  return { runAt, scheduledAt: runAt };
};

/**
 * Schedules tasks from a task process the way `TaskScheduling.bulkSchedule` does for a task without
 * credentials, by writing `task` saved objects. Kibana still claims, validates and runs them.
 * Not supported here, and rejected by name: `runAs`, an explicit `id`, and API key options, which
 * need Task Manager's credential handling. Not done either: the ad hoc task counter (so the
 * `adhoc.created` metric undercounts), `traceparent`, and nudging the claim cycle.
 */
export const createHostTaskScheduling = ({
  repository,
  esClient,
  logger,
  allowedTypes,
}: {
  repository: ISavedObjectsRepository;
  esClient: ElasticsearchClient;
  logger: Logger;
  /** Only task types that match may be scheduled; a process does not know the task definitions. */
  allowedTypes?: RegExp;
}): NonNullable<TaskHost['taskManager']> => ({
  bulkSchedule: async (taskInstances, options) => {
    if (options && (options.apiKey || options.request)) {
      throw new Error(
        'Scheduling with an API key or a request is not supported from a task process'
      );
    }
    const tasks = taskInstances.map(({ runAs, ...taskInstance }, _, all) => {
      if (runAs)
        throw new Error('Scheduling a task with runAs is not supported from a task process');
      if (taskInstance.id) {
        throw new Error('Scheduling a task with an id is not supported from a task process');
      }
      if (allowedTypes && !allowedTypes.test(taskInstance.taskType)) {
        throw new Error(
          `Task type ${taskInstance.taskType} cannot be scheduled from a task process`
        );
      }
      const corrected = ensureDeprecatedFieldsAreCorrected(taskInstance, logger);
      const enabled = corrected.enabled ?? true;
      let scheduling: Partial<{ runAt: Date; scheduledAt: Date }> = {};
      if (enabled) {
        // Run now if there is only a single task, otherwise add jitter so they do not fire together.
        scheduling =
          all.length === 1
            ? { runAt: new Date(), scheduledAt: new Date() }
            : addJitter(corrected.schedule?.interval);
      }
      return { ...corrected, enabled, traceparent: '', ...scheduling } as TaskInstance;
    });

    const objects = tasks.map((task) => {
      const id = v4();
      return {
        type: TASK_SO_NAME,
        id,
        attributes: {
          ...taskInstanceToAttributes(task, id),
          runAt: getFirstRunAt({ taskInstance: task, logger }),
        },
      };
    });
    const { saved_objects: results } = (await repository.bulkCreate(objects as never, {
      refresh: false,
    })) as { saved_objects: Array<{ error?: Error }> };
    return results.map((so) => {
      if (so.error) throw so.error;
      return savedObjectToConcreteTaskInstance(so as never);
    }) as ConcreteTaskInstance[];
  },

  aggregate: async ({ aggs, query, runtime_mappings: runtimeMappings, size = 0 }) => {
    const filterToOnlyTasks = {
      bool: {
        filter: {
          bool: {
            must: [{ term: { type: 'task' } }, { term: { 'task.enabled': true } }],
            must_not: [{ term: { 'task.status': TaskStatus.Unrecognized } }],
          },
        },
      },
    };
    return await esClient.search<ConcreteTaskInstance>({
      index: TASK_MANAGER_INDEX,
      ignore_unavailable: true,
      ...omit({ aggs, runtime_mappings: runtimeMappings, size }, []),
      query: (query
        ? { bool: { must: [filterToOnlyTasks, query] } }
        : filterToOnlyTasks) as estypes.QueryDslQueryContainer,
    });
  },
});
