/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel } from 'node:worker_threads';
import {
  runWatchdogWorker,
  SAMPLE_EXPRESSION,
  type Cadence,
  type InspectorSession,
} from './worker';
import {
  monotonicUs,
  type CurrentTaskContext,
  type EventLoopBlockReport,
  type WorkerToMainMessage,
} from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = (id: string): CurrentTaskContext => ({
  taskId: id,
  taskType: 'type',
  executionUuid: `uuid-${id}`,
});

/** Ten times faster than production, so a case needs a few hundred ms instead of seconds. */
const FAST: Cadence = {
  pollIntervalMs: 5,
  detectThresholdMs: 60,
  sampleAfterMs: 120,
  sampleIntervalMs: 40,
};

interface HarnessOpts {
  /** Runs at the production cadence. */
  realCadence?: boolean;
  /** Delay between an evaluate being posted and landing on the "main thread". */
  landDelayMs?: number;
  /** CPU time reported over the block, in microseconds. */
  cpuUs?: number;
  /** Lets the worker terminate the blocking run. */
  terminate?: boolean;
  /** A terminate leaves the main thread's timers dead: the "block" does not end by itself. */
  terminationBreaksTimers?: boolean;
}

// What the main thread's stack looks like, per shape (see stack_gate.test.ts).
const SAFE_STACK = `    at spin (/kibana/plugin.ts:4:56)
    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:65:14)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;
const UNSAFE_STACK = `    at spin (/kibana/plugin.ts:4:56)
    at Timeout._onTimeout (/kibana/plugin.ts:9:88)
    at listOnTimeout (node:internal/timers:685:17)`;

const setup = ({
  landDelayMs = 0,
  cpuUs = 10_000_000,
  realCadence = false,
  terminate = false,
  terminationBreaksTimers = false,
}: HarnessOpts = {}) => {
  const shared = new BigInt64Array(new SharedArrayBuffer(8));
  let blocked = false;
  const beat = setInterval(() => {
    if (!blocked) Atomics.store(shared, 0, BigInt(monotonicUs()));
  }, 10);
  Atomics.store(shared, 0, BigInt(monotonicUs()));

  const state = {
    current: null as CurrentTaskContext | null,
    stack: SAFE_STACK,
    /** What the main thread reports about having been idle since the previous sample. */
    idle: false,
  };
  const terminations: number[] = [];
  const evaluates: Array<{ expression: string; returnByValue?: boolean; silent?: boolean }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let sessions = 0;
  let disconnects = 0;
  const createSession = (): InspectorSession => {
    sessions++;
    return {
      connectToMainThread: jest.fn(),
      disconnect: () => {
        disconnects++;
      },
      post: (method, params, callback) => {
        if (method === 'Runtime.terminateExecution') {
          terminations.push(monotonicUs());
          // Unwinding the blocking code lets the main thread's heartbeat resume.
          if (!terminationBreaksTimers) blocked = false;
          callback(null, {});
          return;
        }
        evaluates.push(params as never);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          callback(null, {
            result: {
              value: {
                at: monotonicUs(),
                task: state.current,
                missing: false,
                stack: state.stack,
                idleSinceLastSample: state.idle,
              },
            },
          });
        }, landDelayMs);
      },
    };
  };

  const channel = new MessageChannel();
  const messages: WorkerToMainMessage[] = [];
  channel.port1.on('message', (message: WorkerToMainMessage) => messages.push(message));
  const lines: string[] = [];
  runWatchdogWorker(
    channel.port2,
    {
      shared: shared.buffer as SharedArrayBuffer,
      flagThresholdMs: realCadence ? 800 : 200,
      minCpuRatio: 0.5,
      liveReportIntervalMs: realCadence ? 500 : 150,
      terminateEnabled: terminate,
    },
    {
      cadence: realCadence ? undefined : FAST,
      createSession,
      cpuUsage: (previous) => (previous ? { user: cpuUs, system: 0 } : { user: 0, system: 0 }),
      writeLine: (line) => lines.push(line),
    }
  );

  const block = async (ms: number) => {
    blocked = true;
    await sleep(ms);
    blocked = false;
  };
  const reports = (): EventLoopBlockReport[] =>
    messages.flatMap((m) => (m.type === 'block' ? [m.report] : []));
  const waitForReport = async () => {
    for (let i = 0; i < 100 && reports().length === 0; i++) await sleep(25);
    return reports()[0];
  };
  const stop = () => {
    clearInterval(beat);
    channel.port1.close();
    channel.port2.close();
  };
  return {
    state,
    block,
    waitForReport,
    stop,
    lines,
    evaluates,
    messages,
    terminations,
    counts: () => ({ sessions, disconnects, maxInFlight }),
  };
};

describe('runWatchdogWorker', () => {
  let h: ReturnType<typeof setup>;
  afterEach(() => h.stop());

  it('evaluates the current task with the expected options', async () => {
    h = setup();
    h.state.current = owner('a');
    await h.block(450);
    await h.waitForReport();
    expect(h.evaluates.length).toBeGreaterThan(0);
    expect(h.evaluates[0]).toEqual({
      expression: SAMPLE_EXPRESSION,
      returnByValue: true,
      silent: true,
    });
    expect(SAMPLE_EXPRESSION).toContain("Symbol.for('kbn.taskManager.currentTask')");
  });

  it('announces that it is polling before anything else', async () => {
    h = setup();
    await sleep(50);
    expect(h.messages[0]).toEqual({ type: 'ready' });
  });

  it('flags at the production cadence too', async () => {
    h = setup({ realCadence: true });
    h.state.current = owner('a');
    await h.block(1400);
    const report = await h.waitForReport();
    expect(report.flag).toMatchObject({ flagged: true, taskId: 'a' });
  }, 15_000);

  it('flags the task that was current for the whole block, then disconnects the session', async () => {
    h = setup();
    h.state.current = owner('a');
    await h.block(450);
    const report = await h.waitForReport();
    expect(report.flag).toMatchObject({ flagged: true, taskId: 'a', executionUuid: 'uuid-a' });
    expect(report.attribution.perTask).toHaveLength(1);
    expect(Number.isInteger(report.startedAtUs)).toBe(true);
    expect(Number.isInteger(report.endedAtUs)).toBe(true);
    expect(report.endedAtUs).toBeGreaterThan(report.startedAtUs);
    expect(h.counts()).toMatchObject({ sessions: 1, disconnects: 1 });
  });

  it('never has more than one evaluate in flight', async () => {
    h = setup({ landDelayMs: 100 });
    h.state.current = owner('a');
    await h.block(450);
    await h.waitForReport();
    expect(h.counts().maxInFlight).toBe(1);
  });

  it('does not flag a block that was one long uninterruptible call', async () => {
    // The evaluate posted early only lands near the end of the block, naming whoever runs next.
    h = setup({ landDelayMs: 300 });
    h.state.current = owner('b');
    await h.block(500);
    const report = await h.waitForReport();
    expect(report.flag).toEqual({ flagged: false, reason: 'opaque-dominated' });
    expect(report.attribution.opaqueMs).toBeGreaterThan(200);
  });

  it('does not flag a block with no task context', async () => {
    h = setup();
    h.state.current = null;
    await h.block(450);
    const report = await h.waitForReport();
    expect(report.flag).toEqual({ flagged: false, reason: 'no-context' });
  });

  it('does not flag when the process was not busy', async () => {
    h = setup({ cpuUs: 0 });
    h.state.current = owner('a');
    await h.block(450);
    const report = await h.waitForReport();
    expect(report.flag).toEqual({ flagged: false, reason: 'cpu-starved' });
  });

  it('does not open a session for a short block', async () => {
    h = setup();
    h.state.current = owner('a');
    await h.block(80);
    const report = await h.waitForReport();
    expect(report.flag).toEqual({ flagged: false, reason: 'below-threshold' });
    expect(h.counts().sessions).toBe(0);
  });

  it('writes a notice to stderr while the block is still going', async () => {
    h = setup();
    h.state.current = owner('a');
    await h.block(450);
    await h.waitForReport();
    expect(h.lines.some((line) => line.includes('still blocked') && line.includes('"a"'))).toBe(
      true
    );
  });
  describe('terminating the blocking run', () => {
    const terminatedMessages = () =>
      h.messages.flatMap((m) => (m.type === 'terminated' ? [m.notice] : []));

    it('terminates the run once, with its stack, and reports it', async () => {
      h = setup({ terminate: true });
      h.state.current = owner('a');
      await h.block(700);
      const report = await h.waitForReport();

      expect(h.terminations).toHaveLength(1);
      expect(terminatedMessages()).toEqual([
        expect.objectContaining({
          taskId: 'a',
          executionUuid: 'uuid-a',
          taskType: 'type',
          stack: SAFE_STACK,
        }),
      ]);
      expect(report.terminated).toMatchObject({ taskId: 'a', executionUuid: 'uuid-a' });
      expect(report.terminationRefused).toBeUndefined();
      expect(h.lines.some((line) => line.includes('Terminating type "a"'))).toBe(true);
      // The block ended with the termination, long before the simulated 700ms elapsed.
      expect(report.blockedMs).toBeLessThan(600);
    });

    it('posts the terminated message before the block report', async () => {
      h = setup({ terminate: true });
      h.state.current = owner('a');
      await h.block(700);
      await h.waitForReport();
      expect(h.messages.map((m) => m.type).filter((t) => t !== 'ready')).toEqual([
        'terminated',
        'block',
      ]);
    });

    it('never terminates when it is not enabled', async () => {
      h = setup({ terminate: false });
      h.state.current = owner('a');
      await h.block(450);
      const report = await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
      expect(report.terminated).toBeUndefined();
      expect(report.flag).toMatchObject({ flagged: true, taskId: 'a' });
    });

    it('refuses a stack rooted in a timer callback, and says why', async () => {
      h = setup({ terminate: true });
      h.state.current = owner('a');
      h.state.stack = UNSAFE_STACK;
      await h.block(450);
      const report = await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
      expect(report.terminated).toBeUndefined();
      expect(report.terminationRefused).toBe('unsafe-stack');
      expect(h.lines.some((line) => line.includes('Not terminating'))).toBe(true);
    });

    it('refuses when the process was not busy', async () => {
      h = setup({ terminate: true, cpuUs: 0 });
      h.state.current = owner('a');
      await h.block(450);
      const report = await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
      expect(report.terminationRefused).toBe('cpu-starved');
    });

    it('refuses when no task is current', async () => {
      h = setup({ terminate: true });
      h.state.current = null;
      await h.block(450);
      const report = await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
      expect(report.terminationRefused).toBe('no-context');
    });

    it('refuses when the block is one long uninterruptible call', async () => {
      h = setup({ terminate: true, landDelayMs: 300 });
      h.state.current = owner('b');
      await h.block(500);
      await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
    });

    it('does not disable terminations when the main thread is blocked again by something else', async () => {
      // Samples keep landing after the termination, but no immediate ever ran: the main thread was
      // never idle, so this is a new block and not broken timers.
      h = setup({ terminate: true, terminationBreaksTimers: true });
      h.state.current = owner('a');
      h.state.idle = false;
      await h.block(2800);
      await h.waitForReport();

      expect(h.terminations).toHaveLength(1);
      expect(h.messages.some((m) => m.type === 'termination-disabled')).toBe(false);
      expect(h.lines.some((line) => line.includes('CRITICAL'))).toBe(false);
    }, 15_000);

    it('judges the aftermath even when the runner stamps the heartbeat and ends the block', async () => {
      // The terminated run's completion stamps the heartbeat itself, so the block ends although the
      // main thread's timers are dead. The next stale heartbeat is a new block, and an idle main
      // thread in it gives the timers away.
      h = setup({ terminate: true });
      h.state.current = owner('a');
      h.state.idle = true;
      await h.block(700);
      await h.waitForReport();
      expect(h.terminations).toHaveLength(1);

      await sleep(300);
      h.state.current = owner('b');
      // the next block is one that is not terminated, so it goes on long enough to be judged
      h.state.stack = UNSAFE_STACK;
      await h.block(2600);

      expect(h.messages.some((m) => m.type === 'termination-disabled')).toBe(true);
      expect(h.lines.some((line) => line.includes('CRITICAL'))).toBe(true);
    }, 15_000);

    it('goes back to normal once the main thread runs timers again, and terminates again', async () => {
      h = setup({ terminate: true });
      h.state.current = owner('a');
      await h.block(700);
      await h.waitForReport();
      expect(h.terminations).toHaveLength(1);

      // a healthy couple of seconds: the aftermath is judged fine
      await sleep(2300);
      h.state.idle = true; // an idle probe now means nothing: nothing is being watched
      await h.block(700);

      expect(h.terminations).toHaveLength(2);
      expect(h.messages.some((m) => m.type === 'termination-disabled')).toBe(false);
    }, 15_000);

    it('does not terminate when the block ended before the terminate was sent', async () => {
      h = setup({ terminate: true });
      h.state.current = owner('a');
      // a block that is just over the detection threshold ends before the flag threshold
      await h.block(150);
      await h.waitForReport();
      expect(h.terminations).toHaveLength(0);
    });

    it('disables terminations for good when the main thread is idle but its timers are dead', async () => {
      h = setup({ terminate: true, terminationBreaksTimers: true });
      h.state.current = owner('a');
      h.state.idle = true;
      await h.block(2800);
      await h.waitForReport();

      expect(h.terminations).toHaveLength(1);
      expect(h.messages.some((m) => m.type === 'termination-disabled')).toBe(true);
      expect(h.lines.some((line) => line.includes('CRITICAL'))).toBe(true);

      // A later block of the same kind is refused.
      await sleep(100);
      await h.block(450);
      expect(h.terminations).toHaveLength(1);
    }, 15_000);
  });
});
