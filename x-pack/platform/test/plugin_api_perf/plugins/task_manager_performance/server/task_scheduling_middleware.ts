/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Middleware } from '@kbn/task-manager-plugin/server/lib/middleware';
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';

export const TASK_MANAGER_PERFORMANCE_MIDDLEWARE_ID = 'task_manager_performance';

/** Creates the native scheduling callbacks shared by Main and task workers. */
export const createTaskManagerPerformanceMiddleware = (): Middleware => ({
  async beforeSave({ taskInstance, ...opts }) {
    const modifiedInstance = {
      ...taskInstance,
    };

    if (taskInstance.params && taskInstance.params.trackExecutionTimeline) {
      modifiedInstance.state = modifiedInstance.state || {};
      modifiedInstance.state.perf = modifiedInstance.state.perf || {};
      modifiedInstance.state.perf.id = uuidv4().replace(/-/gi, '_');
      const scheduled = performance.mark(`perfTask_schedule_${modifiedInstance.state.perf.id}`);
      modifiedInstance.state.perf.scheduledAt = performance.timeOrigin + scheduled.startTime;
    }

    return {
      ...opts,
      taskInstance: modifiedInstance,
    };
  },

  async beforeRun(opts) {
    return opts;
  },

  async beforeMarkRunning({ taskInstance, ...opts }) {
    const modifiedInstance = {
      ...taskInstance,
    };

    if (modifiedInstance.state && modifiedInstance.state.perf && modifiedInstance.state.perf.id) {
      const { counter = 1 } = modifiedInstance.state;
      const running = performance.mark(
        `perfTask_markAsRunning_${modifiedInstance.state.perf.id}_${counter}`
      );
      if (counter === 1) {
        measureTaskFromSchedule(
          'perfTask.firstMarkAsRunning',
          running.startTime,
          modifiedInstance.state.perf.scheduledAt
        );
      } else if (counter > 1) {
        performance.measure(
          'perfTask.runUntilNextMarkAsRunning',
          `perfTask_run_${modifiedInstance.state.perf.id}_${counter - 1}`,
          `perfTask_markAsRunning_${modifiedInstance.state.perf.id}_${counter}`
        );
      }
    }

    return {
      ...opts,
      taskInstance: modifiedInstance,
    };
  },
});

/** Measures elapsed time from the persisted scheduling timestamp across process boundaries. */
export const measureTaskFromSchedule = (name: string, end: number, scheduledAt: number): void => {
  if (!Number.isFinite(scheduledAt))
    throw new Error('Performance middleware did not persist its scheduling timestamp');
  performance.measure(name, {
    end,
    duration: Math.max(0, performance.timeOrigin + end - scheduledAt),
  });
};
