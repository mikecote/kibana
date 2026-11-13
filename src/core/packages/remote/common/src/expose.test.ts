/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { RpcTarget } from 'capnweb';
import { expose } from './expose';
import { Counter } from './__fixtures__/counter';
import { Root } from './__fixtures__/root';

describe('expose', () => {
  it('adapts methods without moving private fields off the author instance', () => {
    const counter = new Counter();
    const adapter = expose(counter) as RpcTarget & Counter;
    expect(adapter).toBeInstanceOf(RpcTarget);
    expect(adapter.add(3)).toBe(5);
    expect(counter.add(1)).toBe(6);
  });

  it('wraps marked results, including promises, but leaves facts as data', async () => {
    const root = expose(new Root()) as RpcTarget & Root;
    expect(root.child()).toBeInstanceOf(RpcTarget);
    expect(await root.childAsync()).toBeInstanceOf(RpcTarget);
    expect(root.facts()).toEqual({ enabled: true });
  });
});
