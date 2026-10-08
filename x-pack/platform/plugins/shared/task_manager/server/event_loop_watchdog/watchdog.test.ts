/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mockLogger } from '../test_utils';
import type { EventLoopWatchdogConfig } from '../config';
import type { WorkerToMainMessage } from './types';
import { EventLoopWatchdog } from './watchdog';

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));

class FakeWorker extends EventEmitter {
  public terminated = false;
  public unrefed = false;
  public posted: unknown[] = [];

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  unref() {
    this.unrefed = true;
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }

  emitMessage(message: WorkerToMainMessage) {
    this.emit('message', message);
  }
}

let lastCreatedWorker: FakeWorker | undefined;

const WorkerMock = Worker as unknown as jest.Mock;
WorkerMock.mockImplementation(() => {
  lastCreatedWorker = new FakeWorker();
  return lastCreatedWorker;
});

const baseConfig: EventLoopWatchdogConfig = {
  enabled: true,
  threshold_ms: 500,
  heartbeat_interval_ms: 100,
  live_report_interval_ms: 3000,
  dedup_window_ms: 300000,
  track_current_task: true,
};

describe('EventLoopWatchdog', () => {
  beforeEach(() => {
    lastCreatedWorker = undefined;
    WorkerMock.mockClear();
  });

  test('does nothing when disabled in config', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({
      logger,
      config: { ...baseConfig, enabled: false },
      dist: false,
    });

    watchdog.start();

    expect(watchdog.isEnabled).toBe(false);
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  test('spawns an unref-ed worker and logs on start', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });

    watchdog.start();

    expect(watchdog.isEnabled).toBe(true);
    expect(WorkerMock).toHaveBeenCalledTimes(1);
    expect(lastCreatedWorker!.unrefed).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Enabled'));

    watchdog.stop();
  });

  test('is a no-op to start twice', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });

    watchdog.start();
    watchdog.start();

    expect(WorkerMock).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  test('beginRun posts run-start/run-end with a handle to the worker', async () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });
    watchdog.start();

    const scope = watchdog.beginRun('task-a', 'alerting:rule');
    expect(scope.handle).toBeGreaterThan(0);
    await scope.run(() => Promise.resolve());
    scope.end();

    expect(lastCreatedWorker!.posted).toEqual([
      {
        type: 'run-start',
        handle: scope.handle,
        taskId: 'task-a',
        taskType: 'alerting:rule',
        startedAt: expect.any(Number),
      },
      { type: 'run-end', handle: scope.handle },
    ]);

    watchdog.stop();
  });

  test('beginRun assigns distinct handles to concurrent runs', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });
    watchdog.start();

    const scopeA = watchdog.beginRun('task-a', 'alerting:rule');
    const scopeB = watchdog.beginRun('task-b', 'reporting:generate');

    expect(scopeA.handle).not.toEqual(scopeB.handle);

    scopeA.end();
    scopeB.end();
    watchdog.stop();
  });

  test('end() is idempotent and only posts run-end once', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });
    watchdog.start();

    const scope = watchdog.beginRun('task-a', 'alerting:rule');
    scope.end();
    scope.end();

    const runEndMessages = lastCreatedWorker!.posted.filter(
      (message) => (message as { type: string }).type === 'run-end'
    );
    expect(runEndMessages).toHaveLength(1);

    watchdog.stop();
  });

  test('beginRun before start (or after stop) is safely a no-op scope', async () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });

    const scopeBeforeStart = watchdog.beginRun('task-a', 'alerting:rule');
    expect(await scopeBeforeStart.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(() => scopeBeforeStart.end()).not.toThrow();

    watchdog.start();
    watchdog.stop();

    const scopeAfterStop = watchdog.beginRun('task-a', 'alerting:rule');
    expect(() => scopeAfterStop.end()).not.toThrow();
    expect(lastCreatedWorker!.terminated).toBe(true);
  });

  test('does not spawn the current-task tracker when track_current_task is disabled', async () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({
      logger,
      config: { ...baseConfig, track_current_task: false },
      dist: false,
    });
    watchdog.start();

    const scope = watchdog.beginRun('task-a', 'alerting:rule');
    // Still runs the callback (just without stamping the shared current-task slot).
    expect(await scope.run(() => Promise.resolve('ran'))).toBe('ran');
    scope.end();

    watchdog.stop();
  });

  test('logs a warning when the worker reports a block', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });
    watchdog.start();

    lastCreatedWorker!.emitMessage({
      type: 'report',
      report: {
        blockedMs: 750,
        startedAt: 1,
        endedAt: 751,
        blockingTask: { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 700 },
        attribution: 'exact',
        suspects: [{ taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 700 }],
        topFrames: [],
        gcDominant: false,
        likelyUnsampled: false,
        sampledCoverage: 0.9,
        suppressedCount: 0,
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blocked for 750ms'));

    watchdog.stop();
  });

  test('logs worker errors visibly (warn) and disables on a worker crash', () => {
    const logger = mockLogger();
    const watchdog = new EventLoopWatchdog({ logger, config: baseConfig, dist: false });
    watchdog.start();

    lastCreatedWorker!.emitMessage({ type: 'worker-error', message: 'boom' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));

    lastCreatedWorker!.emit('error', new Error('worker died'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('worker died'));
    expect(watchdog.isEnabled).toBe(false);
  });
});
