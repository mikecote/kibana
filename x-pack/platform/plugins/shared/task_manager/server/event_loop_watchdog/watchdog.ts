/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger } from '@kbn/core/server';
import type { EventLoopWatchdogConfig } from '../config';
import { CurrentTaskTracker } from './current_task_tracker';
import { formatReport } from './report';
import {
  HEARTBEAT_SLOT,
  SHARED_BUFFER_BYTE_LENGTH,
  type EventLoopWatchdogOpts,
  type MainToWorkerMessage,
  type TaskRunHandle,
  type TaskRunScope,
  type WorkerData,
  type WorkerToMainMessage,
} from './types';

export interface EventLoopWatchdogDeps {
  logger: Logger;
  config: EventLoopWatchdogConfig;
  /** Whether this build is running as a compiled dist (affects the worker module path). */
  dist: boolean;
}

/**
 * Detects blocks of the main event loop by comparing wall-clock time against a heartbeat
 * stamped from the main thread, entirely from a separate worker thread. See
 * `worker.ts` for the detection and profiling logic; this class only owns the heartbeat
 * (and, when enabled, the `async_hooks`-based current-task tracking), the worker's
 * lifecycle, and turning its messages into log lines.
 */
export class EventLoopWatchdog {
  private readonly logger: Logger;
  private readonly config: EventLoopWatchdogConfig;
  private readonly workerModulePath: string;

  private sharedBuffer?: SharedArrayBuffer;
  private heartbeatView?: BigInt64Array;
  private heartbeatTimer?: NodeJS.Timeout;
  private worker?: Worker;
  private tracker?: CurrentTaskTracker;
  private nextRunHandle: TaskRunHandle = 1;
  private enabled = false;

  constructor({ logger, config, dist }: EventLoopWatchdogDeps) {
    this.logger = logger.get('event-loop-watchdog');
    this.config = config;
    // running in dist: `worker.ts` becomes `worker.js`; running from source, the harness
    // bootstraps ts-node so the worker thread can load the TS file directly.
    this.workerModulePath = path.resolve(
      __dirname,
      dist ? './worker.js' : './worker_src_harness.js'
    );
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  /** Starts the heartbeat and the watchdog worker. No-op when disabled in config. */
  public start(): void {
    if (this.enabled || !this.config.enabled) return;
    this.enabled = true;

    this.sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_BYTE_LENGTH);
    this.heartbeatView = new BigInt64Array(this.sharedBuffer);
    Atomics.store(this.heartbeatView, HEARTBEAT_SLOT, BigInt(Date.now()));

    this.heartbeatTimer = setInterval(() => {
      Atomics.store(this.heartbeatView!, HEARTBEAT_SLOT, BigInt(Date.now()));
    }, this.config.heartbeat_interval_ms);
    this.heartbeatTimer.unref?.();

    if (this.config.track_current_task) {
      this.tracker = new CurrentTaskTracker();
      this.tracker.enable(this.sharedBuffer);
    }

    const opts: EventLoopWatchdogOpts = {
      thresholdMs: this.config.threshold_ms,
      heartbeatIntervalMs: this.config.heartbeat_interval_ms,
      pollIntervalMs: Math.max(20, Math.floor(this.config.heartbeat_interval_ms / 2)),
      liveReportIntervalMs: this.config.live_report_interval_ms,
      dedupWindowMs: this.config.dedup_window_ms,
      trackCurrentTask: this.config.track_current_task,
    };
    const workerData: WorkerData = { sharedBuffer: this.sharedBuffer, opts };

    this.worker = new Worker(this.workerModulePath, { workerData });
    // Never let the watchdog keep the process alive; it's a diagnostic, not a workload.
    this.worker.unref();

    this.worker.on('message', (message: WorkerToMainMessage) => this.onWorkerMessage(message));
    this.worker.on('error', (error) => {
      this.logger.error(`Watchdog worker error, disabling: ${error.message}`);
      this.stop();
    });

    this.logger.info(
      `Enabled (threshold_ms=${this.config.threshold_ms}, heartbeat_interval_ms=${this.config.heartbeat_interval_ms}, track_current_task=${this.config.track_current_task}).`
    );
  }

  /** Stops the heartbeat, the current-task tracker, and terminates the worker. */
  public stop(): void {
    if (!this.enabled) return;
    this.enabled = false;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;

    this.tracker?.disable();
    this.tracker = undefined;

    if (this.worker) {
      this.worker.terminate().catch(() => {});
      this.worker = undefined;
    }
  }

  /**
   * Announces a task run to the worker's in-flight registry and, when current-task
   * tracking is enabled, returns a scope that stamps the shared current-task slot while
   * `fn` runs so the worker can attribute a block to this exact run. Safe to call
   * unconditionally, including while the watchdog is disabled or stopped.
   */
  public beginRun(taskId: string, taskType: string): TaskRunScope {
    const handle = this.allocateRunHandle();
    this.postToWorker({ type: 'run-start', handle, taskId, taskType, startedAt: Date.now() });

    const trackedRun = this.tracker?.registerRun(handle);
    let ended = false;

    return {
      handle,
      run: <T>(fn: () => Promise<T>): Promise<T> => (trackedRun ? trackedRun.run(fn) : fn()),
      end: (): void => {
        if (ended) return;
        ended = true;
        trackedRun?.end();
        this.postToWorker({ type: 'run-end', handle });
      },
    };
  }

  private allocateRunHandle(): TaskRunHandle {
    const handle = this.nextRunHandle;
    // `0` is reserved to mean "no task in scope"; wrap before it could ever overflow into
    // a float-imprecise or negative `Int32Array` value.
    this.nextRunHandle = this.nextRunHandle >= 0x7fffffff ? 1 : this.nextRunHandle + 1;
    return handle;
  }

  private postToWorker(message: MainToWorkerMessage): void {
    if (!this.enabled || !this.worker) return;
    this.worker.postMessage(message);
  }

  private onWorkerMessage(message: WorkerToMainMessage): void {
    if (message.type === 'report') {
      this.logger.warn(formatReport(message.report));
    } else if (message.type === 'worker-error') {
      // Logged at `warn`, not `debug`: a failure here (e.g. the inspector session or CPU
      // profiler erroring) silently defeats the watchdog's entire purpose, so it must be
      // visible without opting into debug logging first.
      this.logger.warn(`Watchdog worker error: ${message.message}`);
    }
  }
}
