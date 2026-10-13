/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isTerminationSafeStack } from './stack_gate';

// Captured on Node 24: the shapes a blocked task can have.
const MICROTASK_ROOT = `Error
    at block (/kibana/plugin.ts:4:56)
    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:65:14)
    at AsyncResource.runInAsyncScope (node:async_hooks:227:14)
    at taskRun (/kibana/plugin.ts:9:146)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;

const IO_ROOT = `Error
    at block (/kibana/plugin.ts:4:56)
    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:65:14)
    at AsyncResource.runInAsyncScope (node:async_hooks:227:14)
    at taskRun (/kibana/plugin.ts:9:146)`;

const TIMER_ROOT = `Error
    at block (/kibana/plugin.ts:4:56)
    at ruleExecutor (/kibana/plugin.ts:8:29)
    at Timeout._onTimeout (/kibana/plugin.ts:9:88)
    at listOnTimeout (node:internal/timers:685:17)
    at process.processTimers (node:internal/timers:618:7)`;

const IMMEDIATE_ROOT = `Error
    at block (/kibana/plugin.ts:4:56)
    at Immediate._onImmediate (/kibana/plugin.ts:9:88)
    at process.processImmediate (node:internal/timers:574:21)`;

const DRAINED_BETWEEN_TIMERS = `Error
    at block (/kibana/plugin.ts:4:56)
    at taskRun (/kibana/plugin.ts:9:146)
    at runNextTicks (node:internal/process/task_queues:65:5)
    at listOnTimeout (node:internal/timers:644:9)
    at process.processTimers (node:internal/timers:618:7)`;

describe('isTerminationSafeStack', () => {
  it.each([
    ['a microtask continuation', MICROTASK_ROOT],
    ['an I/O continuation under the async context wrappers', IO_ROOT],
  ])('allows %s', (_, stack) => {
    expect(isTerminationSafeStack(stack)).toEqual({ safe: true });
  });

  it.each([
    ['a timer callback', TIMER_ROOT, 'node:internal/timers'],
    ['an immediate callback', IMMEDIATE_ROOT, 'node:internal/timers'],
    ['a microtask drained between timers', DRAINED_BETWEEN_TIMERS, 'runNextTicks'],
  ])('refuses %s and names the offending frame', (_, stack, frame) => {
    const result = isTerminationSafeStack(stack);
    expect(result.safe).toBe(false);
    expect((result as { frame: string }).frame).toContain(frame);
  });

  it('refuses a timer rooted stack however deep the blocked code is', () => {
    // The dispatcher is at the bottom: a deep call chain must not hide it.
    const deep = Array.from(
      { length: 40 },
      (_, i) => `    at level${i} (/kibana/plugin.ts:${i}:1)`
    );
    const stack = [
      'Error',
      ...deep,
      '    at Timeout._onTimeout (/kibana/plugin.ts:9:88)',
      '    at listOnTimeout (node:internal/timers:685:17)',
      '    at process.processTimers (node:internal/timers:618:7)',
    ].join('\n');
    expect(isTerminationSafeStack(stack).safe).toBe(false);
  });

  it('refuses a stack that filled the capture limit: its root was never seen', () => {
    expect(isTerminationSafeStack(MICROTASK_ROOT, true)).toEqual({
      safe: false,
      frame: expect.stringContaining('capture limit'),
    });
  });

  it.each([[undefined], [''], ['Error']])('refuses a missing stack (%p)', (stack) => {
    expect(isTerminationSafeStack(stack).safe).toBe(false);
  });
});
