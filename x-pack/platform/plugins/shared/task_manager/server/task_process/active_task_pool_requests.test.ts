/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ActiveTaskPoolRequests } from './active_task_pool_requests';

describe('active task pool control requests', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces pending reads and requires a fresh reply after every completed read', async () => {
    const requests = new ActiveTaskPoolRequests(new AbortController().signal);
    const first = requests.getCurrentTasksInPool();
    expect(requests.getCurrentTasksInPool()).toBe(first);
    const [firstId] = requests.getRequestIds();
    expect(requests.completeRequest('another-request', [])).toBe(false);
    const source = ['other-task::execution'];
    expect(requests.completeRequest(firstId, source)).toBe(true);
    source.push('later-task::execution');
    expect(await first).toEqual(['other-task::execution']);
    const next = requests.getCurrentTasksInPool();
    const [nextId] = requests.getRequestIds();
    expect(nextId).not.toBe(firstId);
    expect(requests.completeRequest(firstId, [])).toBe(false);
    expect(requests.completeRequest(nextId, [])).toBe(true);
    expect(await next).toEqual([]);
    requests.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails a timed-out read without supplying an empty or stale pool', async () => {
    const requests = new ActiveTaskPoolRequests(new AbortController().signal, 1000);
    const rejected = expect(requests.getCurrentTasksInPool()).rejects.toThrow('did not answer');
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(requests.getRequestIds()).toEqual([]);
    const next = requests.getCurrentTasksInPool();
    const [id] = requests.getRequestIds();
    requests.completeRequest(id, ['fresh-task::execution']);
    expect(await next).toEqual(['fresh-task::execution']);
    requests.dispose();
  });

  it('rejects pending reads when the execution is aborted', async () => {
    const controller = new AbortController();
    const requests = new ActiveTaskPoolRequests(controller.signal);
    const rejected = expect(requests.getCurrentTasksInPool()).rejects.toThrow('execution ended');
    controller.abort();
    await rejected;
    expect(() => requests.getCurrentTasksInPool()).toThrow();
    expect(requests.getRequestIds()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends pending reads and refuses new ones when the execution finishes', async () => {
    const requests = new ActiveTaskPoolRequests(new AbortController().signal);
    const rejected = expect(requests.getCurrentTasksInPool()).rejects.toThrow('execution ended');
    requests.dispose();
    await rejected;
    await expect(requests.getCurrentTasksInPool()).rejects.toThrow('execution has finished');
    expect(jest.getTimerCount()).toBe(0);
  });
});
