/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { decideQuarantine } from './quarantine_rule';
import type { ContextSample, CurrentTaskContext } from './types';

const taskA: CurrentTaskContext = {
  taskId: 'task-a',
  taskType: 'test:task',
  executionUuid: 'uuid-a',
};
const taskB: CurrentTaskContext = {
  taskId: 'task-b',
  taskType: 'test:task',
  executionUuid: 'uuid-b',
};

const BLOCK_START_US = 1_000_000;
const SAMPLE_INTERVAL_MS = 250;

const sample = (
  task: CurrentTaskContext | null,
  landedAtUs: number,
  overrides: Partial<ContextSample> = {}
): ContextSample => ({
  postedAtUs: landedAtUs - 10,
  landedAtUs,
  task,
  missing: task === null && overrides.missing !== false,
  ...overrides,
});

const baseOpts = {
  blockStartUs: BLOCK_START_US,
  flagThresholdMs: 5000,
  cpuRatio: 0.9,
  minCpuRatio: 0.5,
};

describe('decideQuarantine', () => {
  it('refuses below the flag threshold', () => {
    const nowUs = BLOCK_START_US + 4000 * 1000;
    const samples = [sample(taskA, nowUs - 100)];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'below-threshold',
    });
  });

  it('refuses with fewer than the minimum landed samples', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [sample(taskA, nowUs - 100), sample(taskA, nowUs - 350)];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'too-few-samples',
    });
  });

  it('does not count in-flight samples (no landedAtUs) toward the minimum', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 100),
      sample(taskA, nowUs - 350),
      { postedAtUs: nowUs - 50, task: null, missing: false }, // in flight
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'too-few-samples',
    });
  });

  it('refuses when a landed sample has no task context', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(null, nowUs - 500, { missing: true }),
      sample(taskA, nowUs - 100),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'no-context',
    });
  });

  it('refuses when samples name different executions', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(taskB, nowUs - 500),
      sample(taskA, nowUs - 100),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'multiple-contexts',
    });
  });

  it('refuses when the latest landed sample is stale', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(taskA, nowUs - 600),
      sample(taskA, nowUs - 2 * SAMPLE_INTERVAL_MS * 1000 - 1),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: false,
      reason: 'stale-sample',
    });
  });

  it('refuses when process CPU usage is below the minimum ratio', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(taskA, nowUs - 500),
      sample(taskA, nowUs - 100),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs, cpuRatio: 0.1 })).toEqual({
      quarantine: false,
      reason: 'cpu-starved',
    });
  });

  it('quarantines the task once every gate passes', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(taskA, nowUs - 500),
      sample(taskA, nowUs - 100),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs })).toEqual({
      quarantine: true,
      task: taskA,
    });
  });

  it('respects a custom minSamples', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [sample(taskA, nowUs - 100)];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs, minSamples: 1 })).toEqual({
      quarantine: true,
      task: taskA,
    });
  });

  it('respects a custom sampleIntervalMs for staleness', () => {
    const nowUs = BLOCK_START_US + 6000 * 1000;
    const samples = [
      sample(taskA, nowUs - 800),
      sample(taskA, nowUs - 500),
      sample(taskA, nowUs - 2 * 1000 * 1000 - 1),
    ];
    expect(decideQuarantine(samples, { ...baseOpts, nowUs, sampleIntervalMs: 1000 })).toEqual({
      quarantine: false,
      reason: 'stale-sample',
    });
  });
});
