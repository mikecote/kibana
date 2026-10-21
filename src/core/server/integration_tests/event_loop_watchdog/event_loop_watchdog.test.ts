/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import Crypto from 'node:crypto';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { BehaviorSubject } from 'rxjs';
import { REPO_ROOT } from '@kbn/repo-info';
import { ThreadsService } from '@kbn/core-threads-server-internal';
import { loggerMock, type MockedLogger } from '@kbn/logging-mocks';
import { mockCoreContext } from '@kbn/core-base-server-mocks';
import { ExecutionContextService } from '@kbn/core-execution-context-server-internal';
import { EventLoopWatchdog } from '@kbn/core-metrics-server-internal/src/event_loop_watchdog/event_loop_watchdog';
import type { CpuProfile } from '@kbn/core-metrics-server-internal/src/event_loop_watchdog/profile_summary';

const profiling = { afterMs: 1_000, maxMs: 5_000, cooldownMs: 60_000 };

function spinTheEventLoop(ms: number) {
  const until = performance.now() + ms;
  let counter = 0;
  while (performance.now() < until) counter++;
  return counter;
}

const waitFor = async <T>(fn: () => T | undefined, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await sleep(20);
  }
  throw new Error('timed out waiting for condition');
};

/** A running CPU profiler makes an idle event loop report ~70% utilisation. */
const idleUtilization = async (ms: number) => {
  const start = performance.eventLoopUtilization();
  await sleep(ms);
  return performance.eventLoopUtilization(start).utilization;
};

describe('EventLoopWatchdog (real worker, real inspector profiler)', () => {
  let logger: MockedLogger;
  let watchdog: EventLoopWatchdog;
  let diagnosticDir: string;

  const messages = (level: 'info' | 'warn' | 'error') =>
    logger[level].mock.calls.map(([message]) => String(message));
  const profileLog = (level: 'info' | 'warn' = 'warn') =>
    logger[level].mock.calls.find(([message]) =>
      String(message).startsWith('Event loop block profile')
    );
  const blockLog = () =>
    logger.warn.mock.calls.find(([message]) => String(message).startsWith('Event loop blocked'));
  const metaOf = (meta: unknown) =>
    (meta as { kibana: { event_loop_watchdog: { profile: any } } }).kibana.event_loop_watchdog
      .profile;

  beforeEach(async () => {
    logger = loggerMock.create();
    diagnosticDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'elw-'));
    watchdog = new EventLoopWatchdog({
      threads: new ThreadsService().start(),
      logger,
      sanitizeRoot: REPO_ROOT,
      diagnosticDir,
      profiling,
    });
    watchdog.start();
    await waitFor(() =>
      messages('info').find((message) => message.startsWith('Event loop watchdog started'))
    );
    await sleep(300); // let the worker start polling
  });

  afterEach(async () => {
    await watchdog.stop();
    Fs.rmSync(diagnosticDir, { recursive: true, force: true });
  });

  it('profiles an egregious block while it lasts, locating the blocking code', async () => {
    spinTheEventLoop(2_500);
    const [message, meta] = await waitFor(() => profileLog());
    const profile = metaOf(meta);
    expect(message).toMatch(/profiled after ~1\d{3}ms, profiler start took ~\d+ms/);
    // the spin is the busy frame, and this test file is the Kibana code it ran from
    expect(message).toContain('Kibana code: ');
    expect(profile.kibanaFrames[0].location).toContain('event_loop_watchdog.test.ts');
    expect(profile).toMatchObject({ phase: 'startup', profiled: 1 });
    // sampled at ~99Hz from when profiling started until the block ended
    expect(profile.samples).toBeGreaterThan(50);
    expect(profile.samples).toBeLessThan(200);

    expect(Path.dirname(profile.file)).toBe(diagnosticDir);
    expect(Path.basename(profile.file)).toMatch(
      /^event-loop-block-startup-002\d{3}ms-.*\.cpuprofile$/
    );
    const written: CpuProfile = JSON.parse(Fs.readFileSync(profile.file, 'utf8'));
    expect(written.samples.length).toBeGreaterThan(50);
    expect(logger.error).not.toHaveBeenCalled();
    // the profiler is stopped once the profile is taken
    expect(await idleUtilization(500)).toBeLessThan(0.2);
  });

  it('does not profile shorter blocks', async () => {
    spinTheEventLoop(500);
    await waitFor(() =>
      messages('warn').find((message) => message.startsWith('Event loop blocked for ~'))
    );
    await sleep(500);
    expect(profileLog()).toBeUndefined();
    expect(Fs.readdirSync(diagnosticDir)).toEqual([]);
  });

  it('names running blocks once startup is over', async () => {
    watchdog.markRunning();
    await sleep(200); // a block starts at the last heartbeat: let one follow the mark
    spinTheEventLoop(1_500);
    const [, meta] = await waitFor(() => profileLog());
    expect(Path.basename(metaOf(meta).file)).toMatch(/^event-loop-block-running-001\d{3}ms-/);
  });

  it('never leaves the profiler running when stopped in the middle of a profile', async () => {
    spinTheEventLoop(1_500); // profiling started during the block...
    await watchdog.stop(); // ...and the worker is terminated before it took the profile
    expect(await idleUtilization(500)).toBeLessThan(0.2);
    expect(messages('info')).toContain('Event loop watchdog stopped');
  });

  describe('naming the execution context current during a block', () => {
    let executionContext: ReturnType<ExecutionContextService['setup']>;
    let executionContextService: ExecutionContextService;

    /**
     * Runs `Crypto.pbkdf2Sync` for approximately `ms`, calibrating iterations first (a throwaway
     * warmup call absorbs the one-off cost of the crypto engine's own first-use initialization,
     * which would otherwise make the calibration call look slower than the real one that follows).
     */
    const pbkdf2For = (ms: number) => {
      Crypto.pbkdf2Sync('secret', 'salt', 1_000, 64, 'sha512'); // warmup, not measured
      const calibrationIterations = 200_000;
      const calibrationStart = performance.now();
      Crypto.pbkdf2Sync('secret', 'salt', calibrationIterations, 64, 'sha512');
      const perIteration = (performance.now() - calibrationStart) / calibrationIterations;
      // A generous margin: undershooting fails the test outright, overshooting just slows it down.
      const iterations = Math.max(calibrationIterations, Math.round((ms * 1.5) / perIteration));
      Crypto.pbkdf2Sync('secret', 'salt', iterations, 64, 'sha512');
    };

    beforeEach(() => {
      const core = mockCoreContext.create();
      core.configService.atPath.mockReturnValue(new BehaviorSubject({ enabled: true }));
      executionContextService = new ExecutionContextService(core);
      executionContext = executionContextService.setup();
      executionContext.installInspectorAccessor();
    });

    afterEach(() => {
      executionContextService.stop();
    });

    it('names a task-manager-shaped execution context current when the block ended', async () => {
      executionContext.withContext(
        { type: 'task manager', name: 'run my-task', id: 'task-1' },
        () => spinTheEventLoop(800)
      );
      const [message] = await waitFor(() => blockLog());
      expect(message).toMatch(/task manager "run my-task" id=task-1 held ~\d+ms of ~\d+ms sampled/);
    });

    it('attributes a long synchronous native call (no interrupt checks) as opaque', async () => {
      executionContext.withContext(
        { type: 'task manager', name: 'run my-task', id: 'task-2' },
        () => pbkdf2For(1_200)
      );
      const [message] = await waitFor(() => blockLog());
      expect(message).toContain('ms opaque');
    });
  });
});
