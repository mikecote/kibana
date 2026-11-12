/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createToken, defineCapability } from '@kbn/core-remote-common';
import { composeCapabilities } from '@kbn/core-remote-server-internal';
import { RunCancellation } from './run_cancellation';
import type { TaskProcessRunMetrics } from './wire';

export type GetRunCancellation = (
  executionUuid: string
) => (() => Promise<TaskProcessRunMetrics>) | undefined;
export const RunCancellationToken = createToken<RunCancellation>('taskManager.RunCancellation');

/** The boot root cannot yield run controls until the HTTP server owns that active execution. */
export class WorkerCapabilities {
  constructor(private readonly getCancellation: GetRunCancellation) {}

  forRun(executionUuid: string): RunCancellation {
    const cancelRun = this.getCancellation(executionUuid);
    if (!cancelRun) throw new Error(`No active task execution: ${executionUuid}`);
    const manifest = [
      defineCapability({
        token: RunCancellationToken,
        placement: 'executor',
        scope: 'run',
        needs: [] as const,
        create: () => new RunCancellation(cancelRun),
      }),
    ];
    return composeCapabilities(manifest, 'executor').createRun().get(RunCancellationToken);
  }
}
