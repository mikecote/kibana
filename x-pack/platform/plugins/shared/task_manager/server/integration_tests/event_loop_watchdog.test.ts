/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * Exercises the real worker thread, `SharedArrayBuffer` heartbeat, `async_hooks`-based
 * current-task tracking, and inspector CPU profile capture end to end: no part of the
 * watchdog is mocked here. A synchronous busy-loop stands in for a stuck task blocking the
 * main thread's event loop.
 */

import { mockLogger } from '../test_utils';
import type { EventLoopWatchdogConfig } from '../config';
import { EventLoopWatchdog } from '../event_loop_watchdog';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the watchdog to report a block.');
};

/** Synchronously blocks the calling thread's event loop for approximately `ms`. */
const blockEventLoopFor = (ms: number): void => {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
};

describe('EventLoopWatchdog (end to end)', () => {
  const config: EventLoopWatchdogConfig = {
    enabled: true,
    threshold_ms: 150,
    heartbeat_interval_ms: 20,
    live_report_interval_ms: 500,
    dedup_window_ms: 60_000,
    track_current_task: true,
  };

  let watchdog: EventLoopWatchdog;

  afterEach(() => {
    watchdog?.stop();
  });

  const latestReportLine = (logger: ReturnType<typeof mockLogger>): string => {
    const [line] = logger.warn.mock.calls[logger.warn.mock.calls.length - 1] as [string];
    return line;
  };

  it('attributes a block to the exact task whose code was running when it started', async () => {
    const logger = mockLogger();
    watchdog = new EventLoopWatchdog({ logger, config, dist: false });
    watchdog.start();

    // Two concurrent runs: only one of them will actually block the loop. Exact
    // attribution (unlike the best-effort candidate list) must name only that one.
    const idleScope = watchdog.beginRun('idle-task-id', 'test:idle-task');
    const blockingScope = watchdog.beginRun('blocking-task-id', 'test:blocking-task');

    // Give the worker a moment to spin up and connect its inspector session before the
    // block happens, so the very first heartbeat gap is reliably observed.
    await sleep(200);

    await blockingScope.run(async () => {
      blockEventLoopFor(400);
    });

    await waitFor(() => logger.warn.mock.calls.length > 0);
    idleScope.end();
    blockingScope.end();

    const reportLine = latestReportLine(logger);
    expect(reportLine).toContain('Event loop blocked for');
    expect(reportLine).toContain('blocking task');
    expect(reportLine).toContain('test:blocking-task "blocking-task-id"');
    expect(reportLine).not.toContain('idle-task-id');
  }, 20_000);

  it('reports no exact attribution for a block that happens outside any task run', async () => {
    const logger = mockLogger();
    watchdog = new EventLoopWatchdog({ logger, config, dist: false });
    watchdog.start();

    await sleep(200);

    blockEventLoopFor(400);

    await waitFor(() => logger.warn.mock.calls.length > 0);

    const reportLine = latestReportLine(logger);
    expect(reportLine).toContain('Event loop blocked for');
    expect(reportLine).toContain('no task in scope when the block started');
  }, 20_000);

  it('falls back to the best-effort candidate list when current-task tracking is disabled', async () => {
    const logger = mockLogger();
    watchdog = new EventLoopWatchdog({
      logger,
      config: { ...config, track_current_task: false },
      dist: false,
    });
    watchdog.start();

    const scope = watchdog.beginRun('blocking-task-id', 'test:blocking-task');

    await sleep(200);

    await scope.run(async () => {
      blockEventLoopFor(400);
    });

    await waitFor(() => logger.warn.mock.calls.length > 0);
    scope.end();

    const reportLine = latestReportLine(logger);
    expect(reportLine).toContain('current-task tracking disabled');
    expect(reportLine).toContain('test:blocking-task "blocking-task-id"');
  }, 20_000);

  it('does not spawn a worker or report anything when disabled', async () => {
    const logger = mockLogger();
    watchdog = new EventLoopWatchdog({
      logger,
      config: { ...config, enabled: false },
      dist: false,
    });
    watchdog.start();

    expect(watchdog.isEnabled).toBe(false);

    blockEventLoopFor(400);
    await sleep(300);

    expect(logger.warn).not.toHaveBeenCalled();
  }, 20_000);
});
