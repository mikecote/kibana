/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { nextNativeTurn } from './fresh_turn';

describe('nextNativeTurn', () => {
  it('resolves in a later event loop turn', async () => {
    const order: string[] = [];
    const turn = nextNativeTurn().then(() => order.push('turn'));
    await Promise.resolve();
    order.push('microtask');
    await turn;
    expect(order).toEqual(['microtask', 'turn']);
  });

  it('resolves concurrent calls in order, each in its own turn', async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => nextNativeTurn().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('can be called repeatedly, one turn after another', async () => {
    for (let i = 0; i < 5; i++) await nextNativeTurn();
  });

  it('is not affected by fake timers', async () => {
    jest.useFakeTimers();
    try {
      await expect(nextNativeTurn()).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
