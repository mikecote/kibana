/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { performance } from 'node:perf_hooks';
import type { Logger } from '@kbn/core/server';

/** Deliberately stalls a forked task process for a local process-isolation demonstration. */
export const runProcessIsolationDemo = (
  { blockEventLoopSeconds, memoryMb }: { blockEventLoopSeconds: number; memoryMb: number },
  logger: Pick<Logger, 'warn'>
): void => {
  if (typeof process.send !== 'function' || process.env.TASK_PROCESS_LOG_LAYOUT !== 'json') {
    throw new Error(
      'processIsolationDemo requires a forked task process; refusing to stall Kibana'
    );
  }

  logger.warn(
    `Process isolation demo: pid=${process.pid}, blocking for ${blockEventLoopSeconds}s, allocating ${memoryMb} MiB`
  );
  // Fill commits the pages to RSS, and the reference stays live across the blocking loop.
  const memory = Buffer.alloc(Math.floor(memoryMb * 1024 * 1024), 1);
  const end = performance.now() + blockEventLoopSeconds * 1000;
  // Intentionally ignore cancellation and starve timers, IPC, and HTTP to demonstrate parent termination.
  while (performance.now() < end) {
    memory[0] = 1;
  }
  logger.warn(
    `Process isolation demo finished: pid=${process.pid}, held ${memory.byteLength} bytes`
  );
};
