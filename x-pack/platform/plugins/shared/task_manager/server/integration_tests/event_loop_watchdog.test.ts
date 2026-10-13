/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { pbkdf2Sync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { withSpan } from '@kbn/apm-utils';
import { mockLogger } from '../test_utils';
import { EventLoopWatchdog, nextNativeTurn, runWithCurrentTask } from '../event_loop_watchdog';
import type { CurrentTaskContext, EventLoopBlockReport } from '../event_loop_watchdog';
import { CURRENT_TASK_ACCESSOR } from '../event_loop_watchdog/types';

// Real worker thread and real inspector session: nothing about the watchdog is mocked.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // intentionally block the event loop
  }
};

const ctx = (taskId: string): CurrentTaskContext => ({
  taskId,
  taskType: 'test:task',
  executionUuid: `uuid-${taskId}`,
});

const idleUtilization = async (ms: number) => {
  const before = performance.eventLoopUtilization();
  await sleep(ms);
  return performance.eventLoopUtilization(before).utilization;
};

/**
 * Jest runs the test in a vm context, but the inspector evaluates in the process's real global
 * object, which is where the accessor lives in a running Kibana. Mirror it there.
 */
const realGlobal = runInThisContext('globalThis') as Record<symbol, unknown>;
const mirrorAccessor = () => {
  realGlobal[CURRENT_TASK_ACCESSOR] = (globalThis as Record<symbol, unknown>)[
    CURRENT_TASK_ACCESSOR
  ];
};
const removeMirroredAccessor = () => {
  delete realGlobal[CURRENT_TASK_ACCESSOR];
};

const config = {
  enabled: true,
  flag_threshold_ms: 1000,
  min_cpu_ratio: 0.5,
  live_report_interval_ms: 500,
  terminate_blocking_tasks: false,
};

describe('event loop watchdog (real worker and inspector)', () => {
  let watchdog: EventLoopWatchdog;
  let reports: EventLoopBlockReport[];

  const start = async (overrides: Partial<typeof config> = {}) => {
    watchdog = new EventLoopWatchdog({
      logger: mockLogger(),
      config: { ...config, ...overrides },
    });
    reports = [];
    watchdog.blocks$.subscribe((report) => reports.push(report));
    watchdog.start();
    if (watchdog.isEnabled) mirrorAccessor();
    // the worker transpiles TypeScript from source on boot: wait until it is polling
    if (watchdog.isEnabled) await watchdog.whenReady();
  };

  const waitForReport = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (reports.length === 0 && Date.now() < deadline) await sleep(50);
    return reports[reports.length - 1];
  };

  afterEach(() => {
    watchdog?.stop();
    removeMirroredAccessor();
  });

  it('flags the task that blocked the loop and not the one running concurrently', async () => {
    await start();
    const spinner = runWithCurrentTask(ctx('spinner'), async () => {
      await sleep(10);
      spin(1500);
    });
    const bystander = runWithCurrentTask(ctx('bystander'), async () => {
      await sleep(2500);
    });
    await Promise.all([spinner, bystander]);

    const report = await waitForReport();
    expect(report.flag).toMatchObject({ flagged: true, taskId: 'spinner' });
    expect(report.attribution.perTask.map((t) => t.taskId)).toEqual(['spinner']);
    expect(report.attribution.perTask[0].observedMs).toBeGreaterThan(800);
  }, 60_000);

  it('does not flag a block that was one long native call, and does not blame the next task', async () => {
    await start();
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        // Queued first, so it runs in the same block as soon as the native call returns.
        runWithCurrentTask(ctx('b'), async () => {
          await Promise.resolve();
          spin(100);
        });
        runWithCurrentTask(ctx('a'), () => {
          pbkdf2Sync('password', 'salt', 12_000_000, 64, 'sha512');
        });
        resolve();
      }, 0)
    );

    const report = await waitForReport();
    expect(report.flag.flagged).toBe(false);
    expect(report.attribution.opaqueMs).toBeGreaterThan(report.blockedMs / 2);
    const b = report.attribution.perTask.find((t) => t.taskId === 'b');
    expect(b?.observedMs ?? 0).toBeLessThan(500);
  }, 90_000);

  it('does not flag a block outside any task run', async () => {
    await start();
    spin(1500);
    const report = await waitForReport();
    expect(report.flag).toEqual({ flagged: false, reason: 'no-context' });
    expect(report.attribution.noContextMs).toBeGreaterThan(0);
  }, 60_000);

  it('does nothing when disabled', async () => {
    await start({ enabled: false });
    expect(watchdog.isEnabled).toBe(false);
    expect(CURRENT_TASK_ACCESSOR in globalThis).toBe(false);
    spin(1500);
    await sleep(500);
    expect(reports).toEqual([]);
  }, 60_000);

  it('leaves the event loop idle once a block is over (no inspector session or profiler left)', async () => {
    await start();
    await runWithCurrentTask(ctx('spinner'), async () => {
      await sleep(10);
      spin(1500);
    });
    await waitForReport();
    expect(await idleUtilization(500)).toBeLessThan(0.2);
  }, 60_000);

  describe('observing a run', () => {
    it('resolves the flag for the run that blocked, before the run completes', async () => {
      await start();
      const observation = watchdog.beginRun('uuid-spinner');
      await runWithCurrentTask({ ...ctx('spinner'), executionUuid: 'uuid-spinner' }, async () => {
        await sleep(10);
        spin(1500);
      });

      const found = await observation.end();

      expect(found).toHaveLength(1);
      expect(found[0].flag).toMatchObject({
        flagged: true,
        taskId: 'spinner',
        executionUuid: 'uuid-spinner',
      });
      expect(found[0].startedAtUs).toBeLessThan(found[0].endedAtUs);
    }, 60_000);

    it('resolves nothing for a run that did not block', async () => {
      await start();
      const observation = watchdog.beginRun('uuid-quiet');
      await runWithCurrentTask({ ...ctx('quiet'), executionUuid: 'uuid-quiet' }, async () => {
        await sleep(50);
      });

      expect(await observation.end()).toEqual([]);
    }, 60_000);
  });

  describe('terminating the blocking run', () => {
    const terminating = { terminate_blocking_tasks: true };
    const uuidCtx = (taskId: string) => ({ ...ctx(taskId), executionUuid: `uuid-${taskId}` });

    it('terminates a run that blocks after resuming from I/O, and leaves the loop healthy', async () => {
      await start(terminating);
      const observation = watchdog.beginRun('uuid-spinner');
      let finished = false;
      runWithCurrentTask(uuidCtx('spinner'), async () => {
        await readFile(__filename);
        spin(10_000);
        finished = true;
      });

      const startedAt = Date.now();
      const notice = await Promise.race([
        observation.terminated!,
        sleep(8000).then(() => undefined),
      ]);

      expect(notice).toMatchObject({
        taskId: 'spinner',
        executionUuid: 'uuid-spinner',
        taskType: 'test:task',
      });
      // far sooner than the 10s the run would have taken
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(notice!.stack).toContain('spin');

      // the loop is responsive again, and timers and the AsyncLocalStorage still work
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 20);
      await sleep(300);
      expect(ticked).toBe(true);
      // the terminated run never resumes
      expect(finished).toBe(false);

      const report = await waitForReport();
      expect(report.terminated).toMatchObject({ executionUuid: 'uuid-spinner' });
      expect(report.blockedMs).toBeLessThan(5000);
      expect(await idleUtilization(500)).toBeLessThan(0.2);
    }, 60_000);

    it('terminates a run that blocks on entry, under the wrappers a task run goes through', async () => {
      await start(terminating);
      const observation = watchdog.beginRun('uuid-wrapped');
      let finished = false;
      // The task runner starts the run in its own microtask, with the race already listening.
      const racing = Promise.race([
        Promise.resolve().then(() =>
          withSpan({ name: 'run', type: 'task manager' }, () =>
            runWithCurrentTask(uuidCtx('wrapped'), async () => {
              spin(10_000);
              finished = true;
            })
          )
        ),
        observation.terminated!,
      ]);

      const outcome = await Promise.race([racing, sleep(8000).then(() => 'timed out')]);

      expect(outcome).toMatchObject({ taskId: 'wrapped', executionUuid: 'uuid-wrapped' });
      expect(finished).toBe(false);
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 20);
      await sleep(300);
      expect(ticked).toBe(true);
    }, 60_000);

    // Real rule executors are deep: the Node dispatcher that matters is far below the blocked code.
    const deeply = (depth: number, fn: () => void): void =>
      depth === 0 ? fn() : deeply(depth - 1, fn);

    it('terminates a deeply nested safe run, keeping the top and bottom of its stack', async () => {
      await start(terminating);
      const observation = watchdog.beginRun('uuid-deep');
      runWithCurrentTask(uuidCtx('deep'), async () => {
        await readFile(__filename);
        deeply(80, () => spin(10_000));
      });

      const notice = await Promise.race([
        observation.terminated!,
        sleep(8000).then(() => undefined),
      ]);

      expect(notice).toMatchObject({ executionUuid: 'uuid-deep' });
      expect(notice!.stack).toContain('spin');
      expect(notice!.stack).toMatch(/\.\.\. \d+ more frames/);
    }, 60_000);

    it('refuses a deeply nested run inside a timer callback: the dispatcher is below the stack limit of old', async () => {
      await start(terminating);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          runWithCurrentTask(uuidCtx('deep-in-timer'), () => deeply(80, () => spin(2500)));
          resolve();
        }, 0)
      );

      const report = await waitForReport();

      expect(report.terminated).toBeUndefined();
      expect(report.terminationRefused).toBe('unsafe-stack');
      expect(report.blockedMs).toBeGreaterThan(2000);
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 20);
      await sleep(300);
      expect(ticked).toBe(true);
    }, 60_000);

    it('lets work queued beside the run survive, as the task poller needs', async () => {
      // A termination drops every continuation queued in the same microtask checkpoint. The task
      // poller's own continuation used to share the run's, and Task Manager never polled again.
      // The runner starts the run in its own native turn: nothing queued beside it is lost.
      await start(terminating);
      const observation = watchdog.beginRun('uuid-sibling');
      const survived: string[] = [];

      const racing = Promise.race([
        nextNativeTurn().then(() =>
          runWithCurrentTask(uuidCtx('sibling'), async () => {
            spin(10_000);
          })
        ),
        observation.terminated!,
      ]);
      // queued right after the run was started, in the same tick
      Promise.resolve().then(() => survived.push('microtask'));
      (async () => {
        for (let poll = 1; poll <= 3; poll++) {
          await sleep(20);
          survived.push(`poll ${poll}`);
        }
      })();

      const outcome = await Promise.race([racing, sleep(8000).then(() => 'timed out')]);

      expect(outcome).toMatchObject({ executionUuid: 'uuid-sibling' });
      await sleep(300);
      expect(survived).toEqual(['microtask', 'poll 1', 'poll 2', 'poll 3']);
    }, 60_000);

    it('refuses to terminate a run that blocks inside a timer callback, and survives it', async () => {
      await start(terminating);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          runWithCurrentTask(uuidCtx('in-timer'), () => spin(2500));
          resolve();
        }, 0)
      );

      const report = await waitForReport();

      expect(report.terminated).toBeUndefined();
      expect(report.terminationRefused).toBe('unsafe-stack');
      expect(report.blockedMs).toBeGreaterThan(2000);
      // timers still fire: terminating here would have broken them
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 20);
      await sleep(300);
      expect(ticked).toBe(true);
    }, 60_000);

    it('does not terminate a block that is one long native call', async () => {
      await start(terminating);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          runWithCurrentTask(uuidCtx('native'), () => {
            pbkdf2Sync('password', 'salt', 12_000_000, 64, 'sha512');
          });
          resolve();
        }, 0)
      );

      const report = await waitForReport();

      expect(report.terminated).toBeUndefined();
    }, 90_000);

    it('does not terminate when it is not enabled', async () => {
      await start({ terminate_blocking_tasks: false });
      const observation = watchdog.beginRun('uuid-spinner');
      expect(observation.terminated).toBeUndefined();
      await runWithCurrentTask(uuidCtx('spinner'), async () => {
        await readFile(__filename);
        spin(1500);
      });

      const report = await waitForReport();

      expect(report.terminated).toBeUndefined();
      expect(report.flag).toMatchObject({ flagged: true, taskId: 'spinner' });
    }, 60_000);
  });
});
