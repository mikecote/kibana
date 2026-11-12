/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IpcSession } from '@kbn/core-remote-server-internal';
import type { WorkerCapabilities } from './worker_capabilities';
import type { TaskProcessRunMetrics } from './wire';

/** Pushes cancellation within the existing grace bound, disposing the run capability after ack. */
export const cancelOverSession = async (
  session: IpcSession<WorkerCapabilities>,
  executionUuid: string,
  gracePeriodMs: number
): Promise<TaskProcessRunMetrics> => {
  let timer: NodeJS.Timeout | undefined;
  const cancel = async (): Promise<TaskProcessRunMetrics> => {
    const capability = await session.remote.forRun(executionUuid);
    try {
      return await capability.cancel();
    } finally {
      capability[Symbol.dispose]();
    }
  };
  try {
    return await Promise.race([
      cancel(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Task cancellation grace period expired')),
          gracePeriodMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
