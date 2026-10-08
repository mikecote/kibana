/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Layout of the single `SharedArrayBuffer` shared between the main thread and the
 * watchdog worker. Kept byte-aligned so a `BigInt64Array` view (heartbeat) and an
 * `Int32Array` view (current task handle) can coexist over the same backing buffer.
 *
 * | bytes | view                | purpose                                             |
 * |-------|---------------------|------------------------------------------------------|
 * | 0-7   | `BigInt64Array[0]`  | heartbeat timestamp (`Date.now()`), stamped by main |
 * | 8-11  | `Int32Array[2]`     | current task run handle (`0` = none)                |
 * | 12-15 | (reserved)          | unused, keeps the buffer 8-byte aligned             |
 */
export const SHARED_BUFFER_BYTE_LENGTH = 16;
/** Index into a `BigInt64Array` view of the shared buffer. */
export const HEARTBEAT_SLOT = 0;
/** Index into an `Int32Array` view of the shared buffer. */
export const CURRENT_TASK_HANDLE_SLOT = 2;

/** Configuration accepted by the watchdog, resolved from `EventLoopWatchdogConfig`. */
export interface EventLoopWatchdogOpts {
  /** Minimum uninterrupted event-loop block duration (ms) that triggers a report. */
  thresholdMs: number;
  /** How often (ms) the main thread stamps its heartbeat. */
  heartbeatIntervalMs: number;
  /** How often (ms) the worker checks the heartbeat for staleness. */
  pollIntervalMs: number;
  /** How often (ms) a still-blocked notice is emitted while a block is ongoing. */
  liveReportIntervalMs: number;
  /** Suppress repeat full reports for the same task type within this window (ms). */
  dedupWindowMs: number;
  /**
   * Whether the main thread maintains `CURRENT_TASK_HANDLE_SLOT` via `async_hooks`. When
   * `false`, the worker never attempts exact attribution from the slot (it would always
   * read `0`, indistinguishable from "no task in scope") and reports `attribution: 'untracked'`.
   */
  trackCurrentTask: boolean;
}

/** Data passed to the worker thread at spawn time. */
export interface WorkerData {
  /** Backing store for the heartbeat and current-task-handle slots, written by the main
   * thread via `Atomics`. See the layout comment above. */
  sharedBuffer: SharedArrayBuffer;
  opts: EventLoopWatchdogOpts;
}

/**
 * A monotonically increasing id assigned to each task run by the main thread, used both
 * as the registry key in the worker and as the value stamped into the shared
 * `CURRENT_TASK_HANDLE_SLOT`. `0` is reserved to mean "no task run in scope".
 */
export type TaskRunHandle = number;

/** Handle returned by `beginTaskRun`/`EventLoopWatchdog#beginRun` for a single task run. */
export interface TaskRunScope {
  readonly handle: TaskRunHandle;
  /** Runs `fn` with the main thread's current-task slot pointing at this run's handle. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Marks the run as finished. Safe to call at most once; later calls are no-ops. */
  end(): void;
}

/** A task run known to be in flight when a block was detected. */
export interface TaskSuspect {
  taskId: string;
  taskType: string;
  /** How long (ms) the task had been running when the block started. */
  inFlightMs: number;
}

/** One aggregated call-tree entry from the captured CPU profile. */
export interface ProfileFrame {
  functionName: string;
  url: string;
  /** Self time attributed to this frame across all samples (ms). */
  selfTimeMs: number;
  /** Self time as a percentage of the total sampled duration. */
  selfTimePercent: number;
}

/**
 * How confidently a block was attributed to a specific task.
 *
 * - `exact`: the `async_hooks`-tracked current-task slot pointed at a task when the block
 *   was first detected; `blockingTask` on the report/notice names it.
 * - `none`: the slot was tracked but empty (e.g. framework/HTTP code, or work running in a
 *   shared/pooled async context not owned by any task) when the block was first detected.
 * - `untracked`: `track_current_task` is disabled, so the slot was never maintained; only
 *   the best-effort `suspects` candidate list is available.
 */
export type BlockAttribution = 'exact' | 'none' | 'untracked';

/** A completed block-detection report, ready to be logged. */
export interface BlockReport {
  blockedMs: number;
  startedAt: number;
  endedAt: number;
  /** The task whose code was executing when the block was first detected, if trackable. */
  blockingTask?: TaskSuspect;
  attribution: BlockAttribution;
  suspects: TaskSuspect[];
  topFrames: ProfileFrame[];
  /** True when garbage collection accounts for most of the sampled self time. */
  gcDominant: boolean;
  /**
   * True when the captured profile samples cover only a small fraction of the block,
   * suggesting a native/syscall wait or OS preemption rather than JS CPU work.
   */
  likelyUnsampled: boolean;
  /** Fraction (0-1) of the block duration actually covered by profiler samples. */
  sampledCoverage: number;
  /** Similar blocks (same suspect task types) suppressed since the last report, if any. */
  suppressedCount: number;
}

/**
 * A block still ongoing, reported periodically so wedged/infinite loops are never silent.
 * Written directly to the process's stderr fd from the worker (see `worker.ts`) rather
 * than sent via `postMessage`, because `postMessage` to the main thread is only processed
 * once its event loop is free again - exactly what does not happen while it is blocked.
 */
export interface StillBlockedNotice {
  elapsedMs: number;
  blockingTask?: TaskSuspect;
  attribution: BlockAttribution;
  suspects: TaskSuspect[];
}

export type MainToWorkerMessage =
  | {
      type: 'run-start';
      handle: TaskRunHandle;
      taskId: string;
      taskType: string;
      startedAt: number;
    }
  | { type: 'run-end'; handle: TaskRunHandle };

export type WorkerToMainMessage =
  | { type: 'report'; report: BlockReport }
  | { type: 'worker-error'; message: string };
