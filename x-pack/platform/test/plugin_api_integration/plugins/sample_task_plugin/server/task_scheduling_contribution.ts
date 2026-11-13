/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskSchedulingContribution } from '@kbn/task-manager-plugin/server/task_scheduling_contribution';
import {
  createSampleTaskMiddleware,
  SAMPLE_TASK_MIDDLEWARE_ID,
} from './task_scheduling_middleware';

export const contribution: TaskSchedulingContribution = {
  middleware: [{ id: SAMPLE_TASK_MIDDLEWARE_ID, create: createSampleTaskMiddleware }],
};
