/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * Runs inside a dedicated worker thread. Detects blocks of the *main* thread's event loop
 * by watching a heartbeat timestamp the main thread writes to a `SharedArrayBuffer`, then
 * captures a CPU profile of the main thread (via `Session.connectToMainThread()`) covering
 * the block, and posts a report back naming the task that was running when it started.
 *
 * Two independent attribution mechanisms feed the report:
 *  - A best-effort *candidate* list (`suspects`): every task-run registered as in-flight
 *    (via `run-start`/`run-end` messages) when the block started. This can only narrow
 *    things down to "one of these", and is racy when a run ends right as the block does.
 *  - *Exact* attribution (`blockingTask`): the main thread (see `current_task_tracker.ts`)
 *    stamps a shared-memory slot with the handle of whichever task-run's async context it
 *    is currently executing inside. Reading that slot the instant a stale heartbeat is
 *    first observed - before the main thread resumes and could overwrite it - names the
 *    task whose *synchronous* continuation actually froze the loop, independent of the
 *    CPU profiler (so it still works for native/syscall blocks the profiler can't sample).
 */

import { isMainThread, parentPort, workerData, threadId } from 'node:worker_threads';
import { Session } from 'node:inspector';
import { writeSync } from 'node:fs';
import type {
  BlockAttribution,
  MainToWorkerMessage,
  StillBlockedNotice,
  TaskRunHandle,
  WorkerData,
  WorkerToMainMessage,
} from './types';
import { CURRENT_TASK_HANDLE_SLOT, HEARTBEAT_SLOT } from './types';
import type { RunRegistryEntry } from './report';
import {
  dedupKeyForBlock,
  formatStillBlockedNotice,
  isLikelyUnsampled,
  MAX_RECENTLY_ENDED_RUNS,
  ReportDeduper,
  resolveBlockingTask,
  snapshotSuspects,
  summarizeProfile,
} from './report';
import type { CpuProfile } from './report';

const STDERR_FD = 2;

/**
 * Writes directly to the process's stderr file descriptor rather than `console.error` or
 * `process.stderr.write`, both of which route worker-thread output through the main
 * thread and would never appear while the main thread's event loop is blocked - exactly
 * the case this exists to report on.
 */
const writeDirectToStderr = (line: string): void => {
  try {
    writeSync(STDERR_FD, `[event-loop-watchdog] ${line}\n`);
  } catch {
    // best-effort: never let reporting itself throw inside the watchdog loop.
  }
};

if (!isMainThread && parentPort) {
  runWatchdogWorker(parentPort, workerData as WorkerData);
}

function runWatchdogWorker(
  port: NonNullable<typeof parentPort>,
  { sharedBuffer, opts }: WorkerData
): void {
  const heartbeat = new BigInt64Array(sharedBuffer);
  const currentTaskHandle = new Int32Array(sharedBuffer);
  const registry = new Map<TaskRunHandle, RunRegistryEntry>();
  // Bounded FIFO of recently-ended runs: a handle captured as the exact blocking task at
  // detection time may finish (via `run-end`) before `Profiler.stop`'s callback resolves
  // it to a taskId/taskType, so it must still be resolvable for a short while afterwards.
  const recentlyEnded = new Map<TaskRunHandle, RunRegistryEntry>();
  const deduper = new ReportDeduper(opts.dedupWindowMs);

  const session = new Session();

  let blockStartedAt: number | undefined;
  let blockingTaskHandle: TaskRunHandle = 0;
  let profiling = false;
  let lastLiveReportAt = 0;

  const post = (message: WorkerToMainMessage): void => port.postMessage(message);

  const reportWorkerError = (context: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'worker-error', message: `${context}: ${message}` });
  };

  try {
    session.connectToMainThread();
  } catch (error) {
    reportWorkerError('connectToMainThread failed', error);
  }

  const rememberEnded = (entry: RunRegistryEntry): void => {
    if (recentlyEnded.size >= MAX_RECENTLY_ENDED_RUNS) {
      const oldestHandle = recentlyEnded.keys().next().value;
      if (oldestHandle !== undefined) recentlyEnded.delete(oldestHandle);
    }
    recentlyEnded.set(entry.handle, entry);
  };

  port.on('message', (message: MainToWorkerMessage) => {
    if (message.type === 'run-start') {
      registry.set(message.handle, {
        handle: message.handle,
        taskId: message.taskId,
        taskType: message.taskType,
        startedAt: message.startedAt,
      });
    } else if (message.type === 'run-end') {
      const entry = registry.get(message.handle);
      registry.delete(message.handle);
      if (entry) rememberEnded(entry);
    }
  });

  const resolveAttribution = (
    startedAt: number
  ): { attribution: BlockAttribution; blockingTask: ReturnType<typeof resolveBlockingTask> } => {
    if (!opts.trackCurrentTask) return { attribution: 'untracked', blockingTask: undefined };
    const blockingTask = blockingTaskHandle
      ? resolveBlockingTask(blockingTaskHandle, startedAt, registry, recentlyEnded)
      : undefined;
    return { attribution: blockingTask ? 'exact' : 'none', blockingTask };
  };

  const startProfiling = (): void => {
    profiling = true;
    session.post('Profiler.enable', (enableErr) => {
      if (enableErr) {
        reportWorkerError('Profiler.enable failed', enableErr);
        return;
      }
      session.post('Profiler.start', (startErr) => {
        if (startErr) reportWorkerError('Profiler.start failed', startErr);
      });
    });
  };

  const stopProfilingAndReport = (blockedMs: number, endedAt: number): void => {
    const startedAt = blockStartedAt ?? endedAt - blockedMs;
    // Snapshot attribution and candidates synchronously, before asking the (also async)
    // profiler to stop: `Profiler.stop`'s callback can land after further runs have
    // started/ended, which would otherwise blame the wrong task (see the worker doc above).
    const { attribution, blockingTask } = resolveAttribution(startedAt);
    const suspects = snapshotSuspects(registry, startedAt);
    session.post('Profiler.stop', (stopErr, result) => {
      profiling = false;
      if (stopErr || !result) {
        reportWorkerError('Profiler.stop failed', stopErr ?? new Error('no profile returned'));
        return;
      }

      const { topFrames, gcDominant, sampledCoverage } = summarizeProfile(
        result.profile as CpuProfile
      );
      const likelyUnsampled = isLikelyUnsampled(sampledCoverage);

      const dedupKey = dedupKeyForBlock(blockingTask, suspects);
      const { action, suppressedCount } = deduper.check(dedupKey, endedAt);
      if (action === 'suppress') return;

      post({
        type: 'report',
        report: {
          blockedMs,
          startedAt,
          endedAt,
          blockingTask,
          attribution,
          suspects,
          topFrames,
          gcDominant,
          likelyUnsampled,
          sampledCoverage,
          suppressedCount,
        },
      });
    });
  };

  const checkHeartbeat = (): void => {
    const now = Date.now();
    const lastHeartbeatMs = Number(Atomics.load(heartbeat, HEARTBEAT_SLOT));
    const age = now - lastHeartbeatMs;

    if (age >= opts.thresholdMs) {
      if (blockStartedAt === undefined) {
        // Block just started: capture the current-task slot *now*, before the main thread
        // can resume and overwrite it. `age` also covers our own poll latency, so anchor
        // the block's start time on the heartbeat's own timestamp for the most accuracy.
        blockingTaskHandle = Atomics.load(currentTaskHandle, CURRENT_TASK_HANDLE_SLOT);
        blockStartedAt = lastHeartbeatMs;
        lastLiveReportAt = now;
        if (!profiling) startProfiling();
        return;
      }

      // Still blocked: emit a live notice periodically so a wedged/infinite loop is never
      // silently unreported, then keep waiting for the heartbeat to resume.
      if (now - lastLiveReportAt >= opts.liveReportIntervalMs) {
        lastLiveReportAt = now;
        const { attribution, blockingTask } = resolveAttribution(blockStartedAt);
        const notice: StillBlockedNotice = {
          elapsedMs: now - blockStartedAt,
          blockingTask,
          attribution,
          suspects: snapshotSuspects(registry, blockStartedAt),
        };
        writeDirectToStderr(formatStillBlockedNotice(notice));
      }
      return;
    }

    if (blockStartedAt !== undefined) {
      // Heartbeat resumed: the block ended when the main thread last stamped, which is
      // `lastHeartbeatMs`+one heartbeat interval ago at most; use `now` as a safe upper bound.
      const blockedMs = now - blockStartedAt;
      const endedAt = now;
      blockStartedAt = undefined;
      if (profiling) {
        stopProfilingAndReport(blockedMs, endedAt);
      }
      blockingTaskHandle = 0;
    }
  };

  const timer = setInterval(checkHeartbeat, opts.pollIntervalMs);
  timer.unref?.();

  port.on('close', () => {
    clearInterval(timer);
    session.disconnect();
  });

  process.on('uncaughtException', (error) => {
    reportWorkerError(`uncaught exception in watchdog worker (thread ${threadId})`, error);
  });
}
