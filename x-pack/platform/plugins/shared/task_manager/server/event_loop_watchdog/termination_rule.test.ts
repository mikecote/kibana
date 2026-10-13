/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { decideTermination } from './termination_rule';
import type { ContextSample } from './types';

const SAFE_STACK = `Error
    at spin (/kibana/plugin.ts:4:56)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;
const UNSAFE_STACK = `Error
    at spin (/kibana/plugin.ts:4:56)
    at listOnTimeout (node:internal/timers:685:17)`;

const task = (uuid: string) => ({
  taskId: `id-${uuid}`,
  taskType: 'test:task',
  executionUuid: uuid,
});

const NOW = 10_000_000;
const sample = (overrides: Partial<ContextSample> = {}): ContextSample => ({
  postedAtUs: NOW - 100_000,
  landedAtUs: NOW - 50_000,
  task: task('a'),
  missing: false,
  stack: SAFE_STACK,
  ...overrides,
});

const opts = {
  nowUs: NOW,
  blockStartUs: NOW - 5_000_000,
  flagThresholdMs: 5000,
  cpuRatio: 1,
  minCpuRatio: 0.5,
};

describe('decideTermination', () => {
  const three = () => [sample(), sample(), sample()];

  it('terminates when every sample names one run, the latest is fresh and the stack is safe', () => {
    expect(decideTermination(three(), opts)).toEqual({
      terminate: true,
      task: task('a'),
      stack: SAFE_STACK,
    });
  });

  it('waits for the flag threshold', () => {
    expect(decideTermination(three(), { ...opts, blockStartUs: NOW - 4_000_000 })).toEqual({
      terminate: false,
      reason: 'below-threshold',
    });
  });

  it('needs enough landed samples, ignoring those still in flight', () => {
    const samples = [sample(), sample(), sample({ landedAtUs: undefined })];
    expect(decideTermination(samples, opts)).toEqual({
      terminate: false,
      reason: 'too-few-samples',
    });
  });

  it.each([
    ['a sample without a task', [sample(), sample({ task: null }), sample()], 'no-context'],
    ['a missing accessor', [sample(), sample({ missing: true }), sample()], 'no-context'],
    [
      'two different runs',
      [sample(), sample({ task: task('b') }), sample({ task: task('b') })],
      'multiple-contexts',
    ],
  ])('refuses with %s', (_, samples, reason) => {
    expect(decideTermination(samples, opts)).toEqual({ terminate: false, reason });
  });

  it('refuses when the latest sample is stale: the block is probably native code', () => {
    const stale = [sample(), sample(), sample({ landedAtUs: NOW - 2_000_000 })];
    expect(decideTermination(stale, opts)).toEqual({ terminate: false, reason: 'stale-sample' });
  });

  it('refuses a missing stack, saying so rather than naming a dangerous frame', () => {
    const samples = [sample(), sample(), sample({ stack: undefined })];
    expect(decideTermination(samples, opts)).toEqual({ terminate: false, reason: 'no-stack' });
  });

  it('refuses a stack that hit the capture limit', () => {
    const samples = [sample(), sample(), sample({ stackTruncated: true })];
    expect(decideTermination(samples, opts)).toEqual({ terminate: false, reason: 'unsafe-stack' });
  });

  it('judges the stack before the CPU ratio, so a busy CI box does not change the reason', () => {
    const samples = [sample(), sample(), sample({ stack: UNSAFE_STACK })];
    expect(decideTermination(samples, { ...opts, cpuRatio: 0.1 })).toEqual({
      terminate: false,
      reason: 'unsafe-stack',
    });
  });

  it('refuses a CPU starved block', () => {
    expect(decideTermination(three(), { ...opts, cpuRatio: 0.1 })).toEqual({
      terminate: false,
      reason: 'cpu-starved',
    });
  });

  it('refuses an unsafe stack, judging only the latest sample', () => {
    const samples = [sample({ stack: SAFE_STACK }), sample(), sample({ stack: UNSAFE_STACK })];
    expect(decideTermination(samples, opts)).toEqual({ terminate: false, reason: 'unsafe-stack' });
    const recovered = [sample({ stack: UNSAFE_STACK }), sample(), sample()];
    expect(decideTermination(recovered, opts).terminate).toBe(true);
  });
});
