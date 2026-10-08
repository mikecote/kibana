/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * Exercises the real `node:async_hooks` machinery (nothing mocked here): correctness of
 * this module depends entirely on real `init`/`before`/`after` callback ordering, which a
 * mock could not faithfully reproduce.
 */

import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { CURRENT_TASK_HANDLE_SLOT } from './types';
import { CurrentTaskTracker } from './current_task_tracker';

const sharedBuffer = () => new SharedArrayBuffer(16);
const readSlot = (buffer: SharedArrayBuffer): number =>
  Atomics.load(new Int32Array(buffer), CURRENT_TASK_HANDLE_SLOT);

describe('CurrentTaskTracker', () => {
  let tracker: CurrentTaskTracker;

  afterEach(() => {
    tracker.disable();
  });

  test('the shared slot is 0 when no run is in scope', () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    expect(readSlot(buffer)).toBe(0);
    expect(tracker.getCurrentHandle()).toBe(0);
  });

  test('stamps the handle while synchronous code inside run() executes', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scope = tracker.registerRun(42);
    let observedDuringRun: number | undefined;
    await scope.run(async () => {
      observedDuringRun = readSlot(buffer);
    });
    scope.end();

    expect(observedDuringRun).toBe(42);
    expect(readSlot(buffer)).toBe(0);
  });

  test('keeps the handle across a macrotask (setImmediate) resumption', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scope = tracker.registerRun(7);
    let observedAfterAwait: number | undefined;
    await scope.run(async () => {
      await setImmediatePromise();
      observedAfterAwait = readSlot(buffer);
    });
    scope.end();

    expect(observedAfterAwait).toBe(7);
  });

  test('keeps the handle across microtask (Promise.resolve) and process.nextTick resumption', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scope = tracker.registerRun(13);
    const observed: number[] = [];
    await scope.run(async () => {
      await Promise.resolve();
      observed.push(readSlot(buffer));
      await new Promise<void>((resolve) => process.nextTick(resolve));
      observed.push(readSlot(buffer));
    });
    scope.end();

    expect(observed).toEqual([13, 13]);
  });

  test('two interleaved runs each see their own handle after awaiting', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scopeA = tracker.registerRun(1);
    const scopeB = tracker.registerRun(2);

    const observedA: number[] = [];
    const observedB: number[] = [];

    const runA = scopeA.run(async () => {
      observedA.push(readSlot(buffer));
      await setImmediatePromise();
      observedA.push(readSlot(buffer));
    });
    const runB = scopeB.run(async () => {
      observedB.push(readSlot(buffer));
      await setImmediatePromise();
      observedB.push(readSlot(buffer));
    });

    await Promise.all([runA, runB]);
    scopeA.end();
    scopeB.end();

    expect(observedA).toEqual([1, 1]);
    expect(observedB).toEqual([2, 2]);
  });

  test('the handle is 0 for code that runs outside any registered run', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scope = tracker.registerRun(5);
    await scope.run(() => Promise.resolve());
    scope.end();

    await setImmediatePromise();
    expect(readSlot(buffer)).toBe(0);
  });

  test('disable() clears the slot and stops tracking', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();
    tracker.enable(buffer);

    const scope = tracker.registerRun(9);
    tracker.disable();

    let observedAfterDisable: number | undefined;
    await scope.run(async () => {
      observedAfterDisable = readSlot(buffer);
    });
    scope.end();

    expect(observedAfterDisable).toBe(0);
    expect(readSlot(buffer)).toBe(0);
  });

  test('registerRun before enable() is safe and never stamps a handle', async () => {
    tracker = new CurrentTaskTracker();
    const buffer = sharedBuffer();

    const scope = tracker.registerRun(3);
    expect(await scope.run(() => Promise.resolve('ok'))).toBe('ok');
    expect(() => scope.end()).not.toThrow();
    expect(readSlot(buffer)).toBe(0);
  });
});
