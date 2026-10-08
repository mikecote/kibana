/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CpuProfile, RunRegistryEntry } from './report';
import {
  dedupKeyForBlock,
  formatReport,
  formatStillBlockedNotice,
  isLikelyUnsampled,
  ReportDeduper,
  resolveBlockingTask,
  snapshotSuspects,
  summarizeProfile,
} from './report';
import type { BlockReport, StillBlockedNotice } from './types';

describe('snapshotSuspects', () => {
  test('computes in-flight duration relative to the block start and sorts by longest first', () => {
    const registry = new Map<number, RunRegistryEntry>([
      [1, { handle: 1, taskId: 'task-a', taskType: 'alerting:rule', startedAt: 1_000 }],
      [2, { handle: 2, taskId: 'task-b', taskType: 'reporting:generate', startedAt: 1_800 }],
    ]);

    const suspects = snapshotSuspects(registry, 2_000);

    expect(suspects).toEqual([
      { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 1_000 },
      { taskId: 'task-b', taskType: 'reporting:generate', inFlightMs: 200 },
    ]);
  });

  test('returns an empty array when nothing is in flight', () => {
    expect(snapshotSuspects(new Map(), 2_000)).toEqual([]);
  });

  test('clamps negative in-flight durations to zero', () => {
    const registry = new Map<number, RunRegistryEntry>([
      [1, { handle: 1, taskId: 'task-a', taskType: 'alerting:rule', startedAt: 5_000 }],
    ]);

    expect(snapshotSuspects(registry, 1_000)).toEqual([
      { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 0 },
    ]);
  });
});

describe('resolveBlockingTask', () => {
  test('resolves a handle still in the live registry', () => {
    const registry = new Map<number, RunRegistryEntry>([
      [1, { handle: 1, taskId: 'task-a', taskType: 'alerting:rule', startedAt: 1_000 }],
    ]);

    expect(resolveBlockingTask(1, 2_000, registry, new Map())).toEqual({
      taskId: 'task-a',
      taskType: 'alerting:rule',
      inFlightMs: 1_000,
    });
  });

  test('falls back to a recently-ended run when the handle already left the live registry', () => {
    const recentlyEnded = new Map<number, RunRegistryEntry>([
      [1, { handle: 1, taskId: 'task-a', taskType: 'alerting:rule', startedAt: 1_000 }],
    ]);

    expect(resolveBlockingTask(1, 2_000, new Map(), recentlyEnded)).toEqual({
      taskId: 'task-a',
      taskType: 'alerting:rule',
      inFlightMs: 1_000,
    });
  });

  test('returns undefined for an unknown handle', () => {
    expect(resolveBlockingTask(99, 2_000, new Map(), new Map())).toBeUndefined();
  });

  test('does not special-case handle 0 itself; callers must guard against it', () => {
    // Handle 0 should never actually be registered by `beginRun`/`registerRun`, but the
    // lookup itself has no special knowledge of that convention - it's the worker's job
    // (see `resolveAttribution` in `worker.ts`) to skip calling this when the captured
    // handle is 0.
    const registry = new Map<number, RunRegistryEntry>([
      [0, { handle: 0, taskId: 'task-a', taskType: 'alerting:rule', startedAt: 1_000 }],
    ]);
    expect(resolveBlockingTask(0, 2_000, registry, new Map())).toEqual({
      taskId: 'task-a',
      taskType: 'alerting:rule',
      inFlightMs: 1_000,
    });
  });
});

const makeProfile = (overrides: Partial<CpuProfile> = {}): CpuProfile => ({
  startTime: 0,
  endTime: 1_000_000,
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '' } },
    { id: 2, callFrame: { functionName: 'JSON.parse', url: 'node:internal' } },
    { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } },
  ],
  samples: [2, 2, 2, 1],
  timeDeltas: [0, 300_000, 300_000, 300_000],
  ...overrides,
});

describe('summarizeProfile', () => {
  test('attributes self time to the sample active during each interval', () => {
    const { topFrames } = summarizeProfile(makeProfile());

    const jsonParse = topFrames.find((frame) => frame.functionName === 'JSON.parse');
    expect(jsonParse?.selfTimeMs).toBeCloseTo(600, 5);
    expect(jsonParse?.selfTimePercent).toBeCloseTo(66.67, 1);
  });

  test('flags GC as dominant when it accounts for most sampled self time', () => {
    const { gcDominant } = summarizeProfile(
      makeProfile({ samples: [3, 3, 3, 2], timeDeltas: [0, 300_000, 300_000, 300_000] })
    );
    expect(gcDominant).toBe(true);
  });

  test('does not flag GC as dominant when it is a minority of sampled self time', () => {
    const { gcDominant } = summarizeProfile(makeProfile());
    expect(gcDominant).toBe(false);
  });

  test('computes sampled coverage relative to the block duration', () => {
    const { sampledCoverage } = summarizeProfile(makeProfile());
    expect(sampledCoverage).toBeCloseTo(0.9, 5);
  });

  test('handles an empty profile without dividing by zero', () => {
    const { topFrames, gcDominant, sampledCoverage } = summarizeProfile(
      makeProfile({ samples: [], timeDeltas: [] })
    );
    expect(topFrames).toEqual([]);
    expect(gcDominant).toBe(false);
    expect(sampledCoverage).toBe(0);
  });
});

describe('isLikelyUnsampled', () => {
  test('flags low sample coverage as likely unsampled (native/syscall wait or preemption)', () => {
    expect(isLikelyUnsampled(0.1)).toBe(true);
  });

  test('does not flag high sample coverage', () => {
    expect(isLikelyUnsampled(0.95)).toBe(false);
  });
});

describe('ReportDeduper', () => {
  test('logs the first occurrence in a window', () => {
    const deduper = new ReportDeduper(60_000);
    expect(deduper.check('alerting:rule', 0)).toEqual({ action: 'log', suppressedCount: 0 });
  });

  test('suppresses repeats within the dedup window', () => {
    const deduper = new ReportDeduper(60_000);
    deduper.check('alerting:rule', 0);
    expect(deduper.check('alerting:rule', 10_000)).toEqual({
      action: 'suppress',
      suppressedCount: 0,
    });
    expect(deduper.check('alerting:rule', 20_000)).toEqual({
      action: 'suppress',
      suppressedCount: 0,
    });
  });

  test('logs again with a suppressed count once the window elapses', () => {
    const deduper = new ReportDeduper(60_000);
    deduper.check('alerting:rule', 0);
    deduper.check('alerting:rule', 10_000); // suppressed
    deduper.check('alerting:rule', 20_000); // suppressed
    expect(deduper.check('alerting:rule', 70_000)).toEqual({
      action: 'log-with-suppressed',
      suppressedCount: 2,
    });
  });

  test('tracks independent windows per key', () => {
    const deduper = new ReportDeduper(60_000);
    deduper.check('alerting:rule', 0);
    expect(deduper.check('reporting:generate', 0)).toEqual({ action: 'log', suppressedCount: 0 });
  });
});

describe('dedupKeyForBlock', () => {
  test('prefers the exact blocking task type when attribution is exact', () => {
    const key = dedupKeyForBlock({ taskId: '1', taskType: 'alerting:rule', inFlightMs: 100 }, [
      { taskId: '2', taskType: 'reporting:generate', inFlightMs: 50 },
    ]);
    expect(key).toBe('task:alerting:rule');
  });

  test('returns a stable, sorted key for the same set of candidates regardless of order', () => {
    const keyA = dedupKeyForBlock(undefined, [
      { taskId: '1', taskType: 'reporting:generate', inFlightMs: 100 },
      { taskId: '2', taskType: 'alerting:rule', inFlightMs: 50 },
    ]);
    const keyB = dedupKeyForBlock(undefined, [
      { taskId: '3', taskType: 'alerting:rule', inFlightMs: 10 },
      { taskId: '4', taskType: 'reporting:generate', inFlightMs: 5 },
    ]);
    expect(keyA).toBe(keyB);
  });

  test('returns a sentinel key when there is no blocking task and no candidates', () => {
    expect(dedupKeyForBlock(undefined, [])).toBe('unattributed');
  });
});

describe('formatReport', () => {
  const baseReport: BlockReport = {
    blockedMs: 812,
    startedAt: 1_000,
    endedAt: 1_812,
    blockingTask: { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 400 },
    attribution: 'exact',
    suspects: [{ taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 400 }],
    topFrames: [
      { functionName: 'JSON.parse', url: 'node:internal', selfTimeMs: 600, selfTimePercent: 80 },
    ],
    gcDominant: false,
    likelyUnsampled: false,
    sampledCoverage: 0.9,
    suppressedCount: 0,
  };

  test('names the exact blocking task and the top frame', () => {
    const line = formatReport(baseReport);
    expect(line).toContain('blocked for 812ms');
    expect(line).toContain('blocking task');
    expect(line).toContain('alerting:rule "task-a"');
    expect(line).toContain('JSON.parse');
  });

  test('falls back to candidates when attribution is "none"', () => {
    const line = formatReport({
      ...baseReport,
      attribution: 'none',
      blockingTask: undefined,
    });
    expect(line).toContain('sole suspect');
    expect(line).toContain('no task in scope when the block started');
  });

  test('reports when current-task tracking is disabled', () => {
    const line = formatReport({
      ...baseReport,
      attribution: 'untracked',
      blockingTask: undefined,
    });
    expect(line).toContain('current-task tracking disabled');
  });

  test('reports when no task was in flight', () => {
    const line = formatReport({
      ...baseReport,
      attribution: 'none',
      blockingTask: undefined,
      suspects: [],
    });
    expect(line).toContain('none in-flight');
  });

  test('lists multiple candidates without claiming certainty', () => {
    const line = formatReport({
      ...baseReport,
      attribution: 'none',
      blockingTask: undefined,
      suspects: [
        { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 400 },
        { taskId: 'task-b', taskType: 'reporting:generate', inFlightMs: 100 },
      ],
    });
    expect(line).toContain('2 candidates');
  });

  test('annotates GC-dominated blocks', () => {
    const line = formatReport({ ...baseReport, gcDominant: true });
    expect(line).toContain('garbage collection dominated');
  });

  test('annotates likely-unsampled blocks with the coverage percentage', () => {
    const line = formatReport({ ...baseReport, likelyUnsampled: true, sampledCoverage: 0.2 });
    expect(line).toContain('only 20%');
    expect(line).toContain('preempted');
  });

  test('includes a note about suppressed similar blocks', () => {
    const line = formatReport({ ...baseReport, suppressedCount: 3 });
    expect(line).toContain('3 similar block(s) suppressed');
  });
});

describe('formatStillBlockedNotice', () => {
  test('names the exact blocking task for an ongoing block', () => {
    const notice: StillBlockedNotice = {
      elapsedMs: 5_432,
      blockingTask: { taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 5_400 },
      attribution: 'exact',
      suspects: [{ taskId: 'task-a', taskType: 'alerting:rule', inFlightMs: 5_400 }],
    };
    const line = formatStillBlockedNotice(notice);
    expect(line).toContain('still blocked after 5432ms and counting');
    expect(line).toContain('blocking task');
    expect(line).toContain('alerting:rule "task-a"');
  });

  test('falls back to candidates when no exact attribution is available', () => {
    const notice: StillBlockedNotice = {
      elapsedMs: 5_432,
      attribution: 'none',
      suspects: [],
    };
    const line = formatStillBlockedNotice(notice);
    expect(line).toContain('none in-flight');
  });
});
