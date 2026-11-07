/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isRetryableError, isUnrecoverableError } from '../task_running/errors';
import { TaskProcessAcquireError } from './acquire_error';
import { RemoteTaskRunner } from './remote_task_runner';
import type { TaskProcessLease } from './remote_task_runner';

describe('RemoteTaskRunner dispatch', () => {
  const request = { taskType: 'alerting:test', taskInstance: {}, executionUuid: 'u' };
  const create = (fetchFn: unknown, extra = {}) => {
    const onDispatchFailure = jest.fn();
    const runner = new RemoteTaskRunner({
      route: { url: 'http://process' },
      request,
      timeoutMs: 1000,
      setCustomTaskRunEventFields: jest.fn(),
      onDispatchFailure,
      fetchFn: fetchFn as typeof fetch,
      ...extra,
    });
    return { runner, onDispatchFailure };
  };

  it('force-releases a child on cancellation without waiting for its HTTP response', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const fetchFn = jest.fn(() => new Promise((resolve) => (finish = resolve)));
    const release = jest.fn();
    const { runner } = create(fetchFn, {
      route: { acquire: async () => ({ url: 'http://child', release }) },
    });
    const run = runner.run();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.cancel();
    expect(release).toHaveBeenCalledWith({ force: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    finish({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'result', result: { state: {} } }),
    });
    await run;
  });

  it('allows a task to acknowledge persisted cancellation before terminating its worker', async () => {
    let finish: (response: object) => void = () => {};
    let acknowledge: (response: object) => void = () => {};
    const running = new Promise<object>((resolve) => (finish = resolve));
    const acknowledgement = new Promise<object>((resolve) => (acknowledge = resolve));
    const fetchFn = jest.fn((url: string) => (url.endsWith('/run') ? running : acknowledgement));
    const release = jest.fn();
    const { runner } = create(fetchFn, {
      route: { acquire: async () => ({ url: 'http://child', release }) },
      request: { ...request, cancelGracePeriodMs: 1000 },
    });
    const run = runner.run();
    await new Promise((resolve) => setImmediate(resolve));
    const cancellation = runner.cancel();
    expect(release).not.toHaveBeenCalled();
    acknowledge({ ok: true });
    await cancellation;
    expect(release).toHaveBeenCalledWith({ force: true });
    finish({ ok: true, json: async () => ({ kind: 'result', result: { state: {} } }) });
    await run;
  });

  it('cancels a run while its worker is starting without dispatching it', async () => {
    let acquired: (lease: TaskProcessLease) => void = () => {};
    const pendingLease = new Promise<TaskProcessLease>((resolve) => (acquired = resolve));
    const fetchFn = jest.fn();
    const release = jest.fn();
    const { runner } = create(fetchFn, { route: { acquire: () => pendingLease } });
    const run = runner.run();
    await runner.cancel();
    acquired({ url: 'http://child', release });
    await expect(run).rejects.toThrow('cancelled');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ force: true });
  });

  it.each([true, false, undefined])(
    'retains a child only with an explicit reusable response (%s)',
    async (reusable) => {
      const release = jest.fn();
      const { runner } = create(
        jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ kind: 'result', result: { state: {} }, reusable }),
        }),
        { route: { acquire: async () => ({ url: 'http://child', release }) } }
      );
      await runner.run();
      expect(release).toHaveBeenCalledWith({ reusable: reusable === true });
    }
  );

  it('fails without retrying when the process lacks a capability', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        kind: 'declined',
        reason: 'The task process lacks connectorTypes [.x]',
      }),
    });
    const { runner, onDispatchFailure } = create(fetchFn);
    const error = await runner.run().catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(isUnrecoverableError(error as Error)).toBe(true);
    expect(error).toHaveProperty('message', expect.stringContaining('lacks connectorTypes [.x]'));
    expect(onDispatchFailure).toHaveBeenCalledWith(
      'alerting:test',
      'declined',
      'The task process lacks connectorTypes [.x]'
    );
  });

  it('reports a process that does not serve the task type', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null });
    const { runner, onDispatchFailure } = create(fetchFn);
    const error = await runner.run().catch((failure: Error) => failure);
    expect(isUnrecoverableError(error as Error)).toBe(true);
    expect(onDispatchFailure).toHaveBeenCalledWith('alerting:test', 'not_served', undefined);
  });

  it('reports a process that could not be started', async () => {
    const { runner, onDispatchFailure } = create(jest.fn(), {
      route: { acquire: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    const error = await runner.run().catch((failure: Error) => failure);
    expect(isRetryableError(error as Error)).toBeInstanceOf(Date);
    expect(onDispatchFailure).toHaveBeenCalledWith(
      'alerting:test',
      'unavailable',
      'the process could not be started: boom'
    );
  });

  it('reports the reason an acquire error carries', async () => {
    const { runner, onDispatchFailure } = create(jest.fn(), {
      route: {
        acquire: jest.fn().mockRejectedValue(new TaskProcessAcquireError('capacity', 'full')),
      },
    });
    const error = await runner.run().catch((failure: Error) => failure);
    expect(isRetryableError(error as Error)).toBeInstanceOf(Date);
    expect(onDispatchFailure).toHaveBeenCalledWith(
      'alerting:test',
      'capacity',
      'the process could not be started: full'
    );
  });
});

describe('RemoteTaskRunner observer', () => {
  const request = { taskType: 'alerting:test', taskInstance: {}, executionUuid: 'u' };
  const answer = (body: unknown) =>
    jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  const create = (fetchFn: unknown, observer = { onResult: jest.fn(), onCancel: jest.fn() }) => ({
    observer,
    runner: new RemoteTaskRunner({
      route: { url: 'http://process' },
      request,
      timeoutMs: 1000,
      setCustomTaskRunEventFields: jest.fn(),
      observer,
      fetchFn: fetchFn as typeof fetch,
    }),
  });

  it('is told the result of a run the process served', async () => {
    const { runner, observer } = create(answer({ kind: 'result', result: { state: { a: 1 } } }));
    await runner.run();
    expect(observer.onResult).toHaveBeenCalledWith({ state: { a: 1 } });
    expect(observer.onCancel).not.toHaveBeenCalled();
  });

  it('is told the task run error of the result, rebuilt as Task Manager sees it', async () => {
    const { runner, observer } = create(
      answer({
        kind: 'result',
        result: { state: {}, taskRunError: { message: 'boom', source: 'user' } },
      })
    );
    await runner.run();
    expect(observer.onResult).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunError: expect.any(Error) })
    );
  });

  it('is not told about execution or capability failures', async () => {
    const thrown = create(
      answer({ kind: 'thrown', error: { message: 'bad', stack: 'x', source: 'framework' } })
    );
    await expect(thrown.runner.run()).rejects.toBeDefined();
    expect(thrown.observer.onResult).not.toHaveBeenCalled();

    const declined = create(
      jest.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ reason: 'r' }) })
    );
    await expect(declined.runner.run()).rejects.toThrow('r');
    expect(declined.observer.onResult).not.toHaveBeenCalled();
  });

  it('is told once when Kibana cancels a run the process has, and not of its result', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const fetchFn = jest.fn((url: string) =>
      url.endsWith('/run')
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ ok: true })
    );
    const { runner, observer } = create(fetchFn);
    const run = runner.run();
    await new Promise((resolve) => setImmediate(resolve));

    await runner.cancel();
    await runner.cancel();
    finish({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'result', result: { state: {} } }),
    });
    await run;

    expect(observer.onCancel).toHaveBeenCalledTimes(1);
    expect(observer.onResult).not.toHaveBeenCalled();
  });

  it('is not told of a cancel before the process was reached', async () => {
    const { runner, observer } = create(jest.fn());
    await runner.cancel();
    expect(observer.onCancel).not.toHaveBeenCalled();
  });

  it('never fails the run when the observer throws', async () => {
    const { runner } = create(answer({ kind: 'result', result: { state: {} } }), {
      onResult: jest.fn(() => {
        throw new Error('observer');
      }),
      onCancel: jest.fn(),
    });
    await expect(runner.run()).resolves.toEqual({ state: {} });
  });
});
