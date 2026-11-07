/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Middleware } from '@kbn/task-manager-plugin/server/lib/middleware';

export const SAMPLE_TASK_MIDDLEWARE_ID = 'sample_task_plugin';

/** Creates the native scheduling callbacks shared by Main and task workers. */
export const createSampleTaskMiddleware = (): Middleware => ({
  async beforeSave({ taskInstance, ...opts }) {
    const modifiedInstance = {
      ...taskInstance,
      params: {
        originalParams: taskInstance.params,
        superFly: 'My middleware param!',
      },
    };

    return {
      ...opts,
      taskInstance: modifiedInstance,
    };
  },

  async beforeRun({ taskInstance, ...opts }) {
    return {
      ...opts,
      taskInstance: {
        ...taskInstance,
        params: taskInstance.params.originalParams,
      },
    };
  },

  async beforeMarkRunning(context) {
    if (context.taskInstance?.params?.originalParams?.throwOnMarkAsRunning) {
      throw new Error(`Sample task ${context.taskInstance.id} threw on MarkAsRunning`);
    }
    return context;
  },
});
