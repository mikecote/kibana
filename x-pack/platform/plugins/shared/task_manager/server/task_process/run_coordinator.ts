/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { remotable } from '@kbn/core-remote-common';
import type { TaskPoolApi } from './task_pool_api';
import type { RunProgressApi } from './run_progress_api';

export class RunCoordinator {
  constructor(
    private readonly pool: TaskPoolApi,
    private readonly progress: RunProgressApi,
    private readonly getCapability?: (tokenId: string) => object
  ) {}

  capability(tokenId: string): object {
    if (!this.getCapability) throw new Error('No placed coordinator capabilities');
    return this.getCapability(tokenId);
  }

  getCurrentTasksInPool(): Promise<readonly string[]> {
    return this.pool.getCurrentTasksInPool();
  }

  reportProgress(createdTaskCount: number): void {
    this.progress.report(createdTaskCount);
  }
}
remotable(RunCoordinator);
