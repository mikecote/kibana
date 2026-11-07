/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from './task_type_module';
import type { NativeTaskSchedulingSchemas } from './task_scheduling_snapshot';

export const TASK_SCHEDULING_CONTRIBUTIONS_KEY = 'task-scheduling';

/** Native schemas and migrations supplied by the plugin that owns a schedulable task type. */
export interface TaskSchedulingContribution {
  createSchemas(
    settings: NonNullable<TaskHost['settings']>
  ): Readonly<Record<string, NativeTaskSchedulingSchemas>>;
}
