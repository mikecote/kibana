/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

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
});
