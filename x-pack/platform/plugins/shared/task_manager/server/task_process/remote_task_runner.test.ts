/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessAcquireError } from './acquire_error';
import { RemoteTaskRunner } from './remote_task_runner';

describe('RemoteTaskRunner fallbacks', () => {
  const request = { taskType: 'alerting:test', taskInstance: {}, executionUuid: 'u' };
  const create = (fetchFn: unknown, extra = {}) => {
    const local = { run: jest.fn().mockResolvedValue({ state: { local: true } }) };
    const onFallback = jest.fn();
    const runner = new RemoteTaskRunner({
      route: { url: 'http://process' },
      request,
      timeoutMs: 1000,
      setCustomTaskRunEventFields: jest.fn(),
      fallback: () => local,
      onFallback,
      fetchFn: fetchFn as typeof fetch,
      ...extra,
    });
    return { runner, local, onFallback };
  };

  it('runs the task in Kibana and reports why when the process declines it', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        kind: 'declined',
        reason: 'The task process lacks connectorTypes [.x]',
      }),
    });
    const { runner, local, onFallback } = create(fetchFn);
    await expect(runner.run()).resolves.toEqual({ state: { local: true } });
    expect(local.run).toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith(
      'alerting:test',
      'declined',
      'The task process lacks connectorTypes [.x]'
    );
  });

  it('reports a process that does not serve the task type', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404, body: null });
    const { runner, onFallback } = create(fetchFn);
    await runner.run();
    expect(onFallback).toHaveBeenCalledWith('alerting:test', 'not_served', undefined);
  });

  it('reports a process that could not be started', async () => {
    const { runner, onFallback } = create(jest.fn(), {
      route: { acquire: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    await runner.run();
    expect(onFallback).toHaveBeenCalledWith(
      'alerting:test',
      'unavailable',
      'the process could not be started: boom'
    );
  });

  it('reports the reason an acquire error carries', async () => {
    const { runner, onFallback } = create(jest.fn(), {
      route: {
        acquire: jest.fn().mockRejectedValue(new TaskProcessAcquireError('capacity', 'full')),
      },
    });
    await runner.run();
    expect(onFallback).toHaveBeenCalledWith(
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
      fallback: () => ({ run: jest.fn().mockResolvedValue({ state: {} }) }),
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

  it('is not told about an error the process threw, or a run Kibana ran itself', async () => {
    const thrown = create(
      answer({ kind: 'thrown', error: { message: 'bad', stack: 'x', source: 'framework' } })
    );
    await expect(thrown.runner.run()).rejects.toBeDefined();
    expect(thrown.observer.onResult).not.toHaveBeenCalled();

    const declined = create(
      jest.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ reason: 'r' }) })
    );
    await declined.runner.run();
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
