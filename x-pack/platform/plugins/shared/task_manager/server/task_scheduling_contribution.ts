/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Middleware } from './lib/middleware';
import type { TaskHost } from './task_type_module';
import type { NativeTaskSchedulingSchemas } from './task_scheduling_snapshot';

export const TASK_SCHEDULING_CONTRIBUTIONS_KEY = 'task-scheduling';

/** Native scheduling schemas, migrations and middleware supplied by their owning plugins. */
export interface TaskSchedulingContribution {
  createSchemas?(
    settings: NonNullable<TaskHost['settings']>
  ): Readonly<Record<string, NativeTaskSchedulingSchemas>>;
  middleware?: ReadonlyArray<{
    id: string;
    create: (settings: NonNullable<TaskHost['settings']>) => Middleware;
  }>;
}
