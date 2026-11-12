/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { remotable } from '@kbn/core-remote-common';
import type { TaskProcessRunMetrics } from './wire';

/** Run-scoped cancellation acknowledges only after the task has finished and cleaned up. */
export class RunCancellation {
  constructor(private readonly cancelRun: () => Promise<TaskProcessRunMetrics>) {}

  cancel(): Promise<TaskProcessRunMetrics> {
    return this.cancelRun();
  }
}
remotable(RunCancellation);
