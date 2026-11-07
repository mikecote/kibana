/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isEqual } from 'lodash';
import type { IntervalSchedule, RruleSchedule } from './task';
import { TaskStatus } from './task';
import type { BulkUpdateSchedulesOptions, BulkUpdateTaskResult } from './task_scheduling';
import type { BulkGetResult, TaskStore } from './task_store';
import { calculateNextRunAtFromSchedule } from './lib/get_next_run_at';
import { retryableBulkUpdate } from './lib/retryable_bulk_update';

/** Updates schedules with the same status rules, credential rotation, and conflict retries in every runtime. */
export const updateTaskSchedules = async ({
  taskIds,
  schedule,
  options,
  store,
  getTasks,
}: {
  taskIds: string[];
  schedule: IntervalSchedule | RruleSchedule;
  options?: BulkUpdateSchedulesOptions;
  store: Pick<TaskStore, 'bulkUpdate'>;
  getTasks: (ids: string[]) => Promise<BulkGetResult>;
}): Promise<BulkUpdateTaskResult> => {
  const { includeRunningTasks = false, ...apiKeyOptions } = options ?? {};
  const shouldRegenerateApiKey = apiKeyOptions.regenerateApiKey === true;
  const updatableStatuses = includeRunningTasks
    ? new Set([TaskStatus.Idle, TaskStatus.Running, TaskStatus.Claiming])
    : new Set([TaskStatus.Idle]);

  return retryableBulkUpdate({
    taskIds,
    store,
    getTasks,
    filter: (task) =>
      updatableStatuses.has(task.status) &&
      (shouldRegenerateApiKey || !isEqual(task.schedule, schedule)),
    map: (task) => {
      if (isEqual(task.schedule, schedule)) {
        return task;
      }

      // For a running/claiming task `runAt` is the time the current execution was due; the task
      // runner computes the next `runAt` from it and the new schedule once the run completes.
      if (task.status !== TaskStatus.Idle) {
        return { ...task, schedule };
      }

      const newRunAtInMs = calculateNextRunAtFromSchedule({
        schedule,
        startDate: task.scheduledAt,
      });

      return { ...task, schedule, runAt: new Date(newRunAtInMs) };
    },
    validate: false,
    /**
     * Because the schedule can be converted from Interval to Rrule and vice versa we want to a void a situation
     * where both are defined by passing mergeAttributes: false here.
     */
    mergeAttributes: false,
    options: apiKeyOptions,
  });
};
