/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
  TASK_PROCESS_PATHS,
} from './protocol';
import { createServer } from 'http';
import type { Server } from 'http';
import { executionContextServiceMock } from '@kbn/core-execution-context-server-mocks';
import { fetch as undiciFetch } from 'undici';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import {
  createRetryableError,
  DeclinedRunError,
  isUnrecoverableError,
} from '../task_running/errors';
import type { CancellableTask, RunContext, TaskRunAsDefinition } from '../task';
import { buildTaskFakeRequest } from '../task_running/fake_request_factory';
import { startTaskProcessServer } from './server';
import { RemoteTaskRunner } from './remote_task_runner';
import { elasticsearchConfigFromEnv } from './es_config';
import { TaskProcessSupervisor } from './supervisor';
import { startTaskProcessWorker } from './worker';
import type { TaskProcessDispatchSnapshot, TaskProcessRunMetrics } from './wire';
import type { TaskExecutionPool } from '../task_scheduling';
import {
  createHostFeatureFlags,
  incrementCreatedTaskCount,
  requestDispatchTaskPool,
  registerRunFlusher,
} from './run_context';
import { firstValueFrom } from 'rxjs';
import type { FakeRequestEnricher } from '@kbn/core-security-server';

const TYPE = 'test:type';
const TOKEN = 'secret';

describe('task process server', () => {
  let server: Server;
  let url: string;
  const cleanup = jest.fn();
  const flush = jest.fn();
  const order: string[] = [];
  let createTask: (context: RunContext) => CancellableTask;
  let runAsDefinition: TaskRunAsDefinition | undefined;
  let enrichFakeRequest: jest.MockedFunction<FakeRequestEnricher>;

  beforeEach(async () => {
    runAsDefinition = undefined;
    enrichFakeRequest = jest.fn();
    cleanup.mockReset();
    order.length = 0;
    flush.mockReset().mockImplementation(async () => {
      order.push('flush');
    });
    createTask = () => ({
      run: async () => {
        order.push('run');
        return { state: { ran: true } };
      },
      cleanup,
    });
    server = startTaskProcessServer({
      executionContext: executionContextServiceMock.createSetupContract(),
      taskDefinitions: new Map([
        [
          TYPE,
          {
            createTaskRunner: (context) => createTask(context),
            get runAs() {
              return runAsDefinition;
            },
          },
        ],
      ]),
      port: 0,
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: '9.9.9',
      authToken: TOKEN,
      flush,
      enrichFakeRequest,
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('listens on the loopback address only when given a host', async () => {
    const loopback = startTaskProcessServer({
      executionContext: executionContextServiceMock.createSetupContract(),
      taskDefinitions: new Map(),
      port: 0,
      host: '127.0.0.1',
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: '9.9.9',
    });
    await new Promise<void>((resolve) => loopback.once('listening', () => resolve()));
    expect((loopback.address() as { address: string }).address).toBe('127.0.0.1');
    loopback.close();
  });

  const runner = (
    overrides: Partial<{
      taskType: string;
      token: string;
      version: string;
      getCurrentTasksInPool: TaskExecutionPool['getCurrentTasksInPool'];
    }> = {}
  ) =>
    new RemoteTaskRunner({
      route: { url, token: overrides.token ?? TOKEN },
      request: {
        taskType: overrides.taskType ?? TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'run-1',
        kibanaVersion: overrides.version ?? '9.9.9',
      },
      timeoutMs: 5000,
      getCurrentTasksInPool: overrides.getCurrentTasksInPool,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
    });

  it('reports the task types it serves', async () => {
    const response = await undiciFetch(`${url}/health`);
    expect(((await response.json()) as { taskTypes: string[] }).taskTypes).toEqual([TYPE]);
  });

  it('advertises the current dispatch contract separately from liveness', async () => {
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.health}`);
    expect(await response.json()).toMatchObject({
      protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
      capabilities: TASK_PROCESS_CAPABILITIES,
      taskTypes: [TYPE],
    });
  });

  it.each([undefined, 1])(
    'rejects protocol %s before creating the task',
    async (protocolVersion) => {
      const create = jest.fn(() => ({ run: async () => ({ state: {} }) }));
      createTask = create;
      const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          protocolVersion,
          taskType: TYPE,
          taskInstance: {},
          executionUuid: 'old',
        }),
      });
      expect(response.status).toBe(409);
      await response.body?.cancel();
      expect(create).not.toHaveBeenCalled();
    }
  );

  it('does not expose an unversioned business route', async () => {
    const create = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    createTask = create;
    const response = await undiciFetch(`${url}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: {},
        executionUuid: 'old-route',
      }),
    });
    expect(response.status).toBe(404);
    await response.body?.cancel();
    expect(create).not.toHaveBeenCalled();
  });

  it('authenticates progress reads and returns the native count before completion', async () => {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    createTask = () => ({
      run: async () => {
        incrementCreatedTaskCount(3);
        started.resolve();
        await completed.promise;
        incrementCreatedTaskCount(2);
        return { state: {} };
      },
    });
    const running = runner().run();
    await started.promise;
    try {
      expect((await undiciFetch(`${url}${TASK_PROCESS_PATHS.metrics}run-1`)).status).toBe(401);
      const progress = await undiciFetch(`${url}${TASK_PROCESS_PATHS.metrics}run-1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await progress.json()).toEqual({ createdTaskCount: 3, activePoolRequestIds: [] });
    } finally {
      completed.resolve();
      await running;
    }
    expect(
      (
        await undiciFetch(`${url}${TASK_PROCESS_PATHS.metrics}run-1`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status
    ).toBe(404);
  });

  it('authenticates and validates pool replies before completing the matching live request', async () => {
    const requested = Promise.withResolvers<void>();
    createTask = () => ({
      run: async () => {
        const pool = requestDispatchTaskPool();
        requested.resolve();
        return { state: { pool: await pool } };
      },
    });
    const running = runner().run();
    await requested.promise;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.metrics}run-1`, { headers });
    const metrics = (await response.json()) as TaskProcessRunMetrics;
    const requestId = metrics.activePoolRequestIds?.[0];
    if (!requestId) throw new Error('The live pool read was not published');
    const reply = (body: object, authorized = true) =>
      undiciFetch(`${url}${TASK_PROCESS_PATHS.activePool}run-1`, {
        method: 'POST',
        headers: authorized ? headers : { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await reply({ requestId, executionIds: [] }, false)).status).toBe(401);
    expect((await reply({ requestId: 'stale', executionIds: [] })).status).toBe(404);
    expect((await reply({ requestId, executionIds: 'invalid' })).status).toBe(400);
    expect((await reply({ requestId, executionIds: ['x'.repeat(4097)] })).status).toBe(400);
    expect((await reply({ requestId, executionIds: ['peer-task::execution'] })).status).toBe(200);
    expect(await running).toEqual({ state: { pool: ['peer-task::execution'] } });
  });

  it('reads the dispatching pool again when it changes within one execution', async () => {
    const livePool = ['first-task::execution'];
    const getCurrentTasksInPool = jest.fn(() => livePool);
    createTask = () => ({
      run: async () => {
        const first = await requestDispatchTaskPool();
        livePool.push('second-task::execution');
        const second = await requestDispatchTaskPool();
        return { state: { first, second } };
      },
    });
    expect(await runner({ getCurrentTasksInPool }).run()).toEqual({
      state: {
        first: ['first-task::execution'],
        second: ['first-task::execution', 'second-task::execution'],
      },
    });
    expect(getCurrentTasksInPool).toHaveBeenCalledTimes(2);
  });

  it('enriches the primary and child requests with this execution identity', async () => {
    createTask = ({ fakeRequest, enrichRequest }) => ({
      run: async () => {
        expect(fakeRequest?.isFakeRequest).toBe(true);
        expect(enrichRequest).toBeDefined();
        const child = buildTaskFakeRequest({ apiKey: 'child-test-key' });
        if (!child || !enrichRequest) throw new Error('Missing child request enrichment');
        enrichRequest(child);
        return { state: {} };
      },
    });
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'enriched-task',
        apiKey: 'primary-test-key',
        userName: 'originating-user',
        userProfileId: 'originating-profile',
      }),
    });
    expect(response.status).toBe(200);
    expect(enrichFakeRequest).toHaveBeenCalledTimes(2);
    expect(enrichFakeRequest).toHaveBeenNthCalledWith(1, expect.anything(), {
      username: 'originating-user',
      profileId: 'originating-profile',
    });
    expect(enrichFakeRequest).toHaveBeenNthCalledWith(2, expect.anything(), {
      username: 'originating-user',
      profileId: 'originating-profile',
    });
  });

  it('runs a task and returns its result, then cleans it up', async () => {
    await expect(runner().run()).resolves.toEqual({ state: { ran: true } });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('finishes runner cleanup in the execution context before flushing effects', async () => {
    const pending = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const flags = createHostFeatureFlags();
    cleanup.mockImplementation(async () => {
      order.push('cleanup');
      expect(await firstValueFrom(flags.getBooleanValue$('test.flag', false))).toBe(true);
      registerRunFlusher(async () => {
        order.push('queued effect');
      });
      entered.resolve();
      await pending.promise;
    });
    const running = undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'complete-before-flush',
        featureFlags: { 'test.flag': true },
      }),
    });
    await entered.promise;
    expect(order).toEqual(['run', 'cleanup']);
    expect(flush).not.toHaveBeenCalled();
    pending.resolve();
    expect((await running).status).toBe(200);
    expect(order.slice(0, 2)).toEqual(['run', 'cleanup']);
    expect(order.slice(2).sort()).toEqual(['flush', 'queued effect']);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('finishes what the run left to do before it answers, and answers with the result alone', async () => {
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'run-flush',
        kibanaVersion: '9.9.9',
      }),
    });

    expect(order).toEqual(['run', 'flush']);
    expect(await response.json()).toEqual({
      kind: 'result',
      createdTaskCount: 0,
      result: { state: { ran: true } },
      reusable: true,
    });
  });

  it('finishes what the run left to do when it throws too', async () => {
    createTask = () => ({
      run: async () => {
        throw new Error('boom');
      },
    });

    await expect(runner().run()).rejects.toThrow('boom');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('answers even when finishing fails', async () => {
    flush.mockRejectedValue(new Error('endpoint down'));

    await expect(runner().run()).resolves.toEqual({ state: { ran: true } });
  });

  it.each(['cleanup', 'flush'])('marks a child non-reusable when %s fails', async (operation) => {
    (operation === 'cleanup' ? cleanup : flush).mockRejectedValue(new Error('failed'));
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'run-cleanup',
        kibanaVersion: '9.9.9',
      }),
    });
    expect(await response.json()).toEqual({
      kind: 'result',
      createdTaskCount: 0,
      result: { state: { ran: true } },
      reusable: false,
    });
  });

  it('returns the error of a task that throws, keeping its retry decoration', async () => {
    const retryAt = new Date('2030-01-01T00:00:00.000Z');
    createTask = () => ({
      run: async () => {
        throw createRetryableError(new Error('boom'), retryAt);
      },
    });
    await expect(runner().run()).rejects.toThrow('boom');
  });

  it('refuses a run without the token', async () => {
    await expect(runner({ token: 'wrong' }).run()).rejects.toThrow(/401/);
  });

  it('refuses a run from another Kibana version without switching execution modes', async () => {
    await expect(runner({ version: '1.0.0' }).run()).rejects.toThrow(/409/);
  });

  it('answers 404 for a task type it does not serve', async () => {
    await expect(runner({ taskType: 'other:type' }).run()).rejects.toThrow(/404/);
  });

  it('isolates initialization and flushers between consecutive executions', async () => {
    const flags = createHostFeatureFlags();
    const flushed: boolean[] = [];
    createTask = () => {
      const enabled = firstValueFrom(flags.getBooleanValue$('test.flag', false));
      registerRunFlusher(async () => {
        flushed.push(await enabled);
      });
      return { run: async () => ({ state: { enabled: await enabled } }) };
    };
    const run = async (enabled: boolean) => {
      const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
          taskType: TYPE,
          taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
          executionUuid: `run-${enabled}`,
          featureFlags: { 'test.flag': enabled },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        kind: 'result',
        result: { state: { enabled } },
        reusable: true,
      });
    };
    await run(true);
    await run(false);
    expect(flushed).toEqual([true, false]);
  });

  it('rejects overlapping executions in the same worker', async () => {
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => (started = resolve));
    const blocked = new Promise<void>((resolve) => (finish = resolve));
    createTask = () => ({
      run: async () => {
        started();
        await blocked;
        return { state: {} };
      },
    });
    const first = runner().run();
    await ready;
    try {
      await expect(runner().run()).rejects.toThrow('503');
    } finally {
      finish();
      await first;
    }
  });

  it('retires a worker when a run flusher fails', async () => {
    createTask = () => {
      registerRunFlusher(async () => {
        throw new Error('metering unavailable');
      });
      return { run: async () => ({ state: {} }) };
    };
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'run-flusher-fails',
      }),
    });
    expect(await response.json()).toMatchObject({ kind: 'result', reusable: false });
  });

  it('reconstructs a workload request using the process task definition', async () => {
    const resolveWorkload = jest.fn();
    runAsDefinition = {
      workloadTypes: ['workflow'],
      withScopedRequest: async (params, fn) => {
        resolveWorkload(params);
        const request = buildTaskFakeRequest({
          apiKey: 'service-account-token',
          spaceId: params.spaceId,
        });
        if (!request) throw new Error('Service account request was not created');
        return fn(request);
      },
    };
    createTask = ({ runAs, fakeRequest }) => ({
      run: async () => {
        expect(fakeRequest).toBeUndefined();
        if (!runAs) throw new Error('Service account context was not supplied');
        return runAs.withScopedRequest(async (request) => ({
          state: {
            authorization: request.headers.authorization,
          },
        }));
      },
    });
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
        executionUuid: 'run-workload',
        apiKey: 'must-not-be-used',
        runAs: {
          workloadType: 'workflow',
          workloadId: 'w1',
          spaceId: 'space1',
          expectedServiceAccountId: 'sa1',
        },
      }),
    });
    expect(await response.json()).toMatchObject({
      kind: 'result',
      result: {
        state: {
          authorization: 'ApiKey service-account-token',
        },
      },
    });
    expect(resolveWorkload).toHaveBeenCalledWith({
      workloadType: 'workflow',
      workloadId: 'w1',
      spaceId: 'space1',
      expectedServiceAccountId: 'sa1',
    });
  });

  it('returns a capability failure without executing in Kibana', async () => {
    createTask = () => ({
      run: async () => {
        throw new DeclinedRunError('uses a connector the process does not know');
      },
      cleanup,
    });
    await expect(runner().run()).rejects.toThrow('uses a connector the process does not know');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

const VERSION = '9.9.9';

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Worker has no port');
  return `http://127.0.0.1:${address.port}`;
};

describe('remote task worker', () => {
  let child: Server;
  let worker: ReturnType<typeof startTaskProcessWorker>;
  let url: string;
  const release = jest.fn();
  const acquire = jest.fn();
  const getTaskTypes = () => [TYPE];

  const snapshot = (enabled: boolean): TaskProcessDispatchSnapshot => ({
    protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
    init: {
      kibanaVersion: VERSION,
      elasticsearch: elasticsearchConfigFromEnv({
        ES_URL: 'http://localhost:9200',
        ES_USERNAME: 'test',
        ES_PASSWORD: 'secret',
      }),
      settings: { plugin: { enabled } },
      parity: [{ kind: 'workflowSteps', ids: ['test.step'] }],
    },
    featureFlags: { 'test.flag': enabled },
  });

  beforeEach(async () => {
    jest.spyOn(TaskProcessSupervisor.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(TaskProcessSupervisor.prototype, 'getTaskTypes').mockImplementation(getTaskTypes);
    jest.spyOn(TaskProcessSupervisor.prototype, 'getRoute').mockReturnValue({ acquire });
    jest.spyOn(TaskProcessSupervisor.prototype, 'stop').mockResolvedValue();
    release.mockReset();
    acquire.mockReset();
    const flags = createHostFeatureFlags();
    child = startTaskProcessServer({
      executionContext: executionContextServiceMock.createSetupContract(),
      taskDefinitions: new Map([
        [
          TYPE,
          {
            createTaskRunner: ({ fakeRequest, setCustomTaskRunEventFields }) => ({
              run: async () => {
                setCustomTaskRunEventFields({ remote: 'preserved' });
                return {
                  state: {
                    enabled: await firstValueFrom(flags.getBooleanValue$('test.flag', false)),
                    authorization: fakeRequest?.headers.authorization,
                  },
                };
              },
            }),
          },
        ],
      ]),
      port: 0,
      host: '127.0.0.1',
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: VERSION,
      authToken: 'child-token',
    });
    acquire.mockResolvedValue({ url: await listen(child), token: 'child-token', release });
    worker = startTaskProcessWorker({
      settings: { bundle_dir: '/unused', kibanaVersion: VERSION },
      logger: loggingSystemMock.createLogger(),
      authToken: TOKEN,
      port: 0,
      host: '127.0.0.1',
    });
    url = await listen(worker.server);
  });

  afterEach(async () => {
    await worker.stop();
    child.closeAllConnections();
    await new Promise<void>((resolve) => child.close(() => resolve()));
    jest.restoreAllMocks();
  });

  it('forwards the current snapshot, credentials, results and custom event fields', async () => {
    for (const enabled of [true, false]) {
      const current = snapshot(enabled);
      const setFields = jest.fn();
      const runner = new RemoteTaskRunner({
        route: { url, token: TOKEN },
        request: {
          taskType: TYPE,
          taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
          executionUuid: `run-${enabled}`,
          kibanaVersion: VERSION,
          apiKey: `key-${enabled}`,
          spaceId: `space-${enabled}`,
          snapshot: current,
        },
        timeoutMs: 10_000,
        setCustomTaskRunEventFields: setFields,
        fetchFn: fetch,
      });
      await expect(runner.run()).resolves.toEqual({
        state: {
          enabled,
          authorization: `ApiKey key-${enabled}`,
        },
      });
      expect(acquire).toHaveBeenLastCalledWith({
        executionUuid: `run-${enabled}`,
        snapshot: current,
      });
      expect(release).toHaveBeenLastCalledWith({ reusable: true });
      expect(setFields).toHaveBeenCalledWith({ remote: 'preserved' });
    }
  });

  it('rejects requests without a snapshot before acquiring an execution process', async () => {
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: {},
        executionUuid: 'missing',
      }),
    });
    expect(await response.json()).toMatchObject({ kind: 'thrown' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('requires the worker token before reading the dispatch credentials', async () => {
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        snapshot: snapshot(true),
      }),
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('native task creation metrics', () => {
  const create = (
    fetchFn: typeof fetch,
    extra: Partial<ConstructorParameters<typeof RemoteTaskRunner>[0]> = {}
  ) => ({
    runner: new RemoteTaskRunner({
      route: { url: 'http://process' },
      request: { taskType: 'test', taskInstance: {}, executionUuid: 'u' },
      timeoutMs: 1000,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: async (input, init) =>
        String(input).endsWith(TASK_PROCESS_PATHS.health)
          ? Response.json({
              protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
              capabilities: TASK_PROCESS_CAPABILITIES,
            })
          : fetchFn(input, init),
      ...extra,
    }),
  });
  it('counts monotonic progress and the final total once, then stops polling', async () => {
    jest.useFakeTimers();
    try {
      const result = Promise.withResolvers<Response>();
      const onTasksCreated = jest.fn();
      const samples = [2, 2, 1, 4];
      const fetchFn: typeof fetch = jest.fn(async (input) => {
        if (String(input).endsWith('/run')) return result.promise;
        return Response.json({ createdTaskCount: samples.shift() });
      });
      const { runner } = create(fetchFn, { onTasksCreated, timeoutMs: 10000 });
      const running = runner.run();
      await jest.advanceTimersByTimeAsync(4000);
      expect(onTasksCreated.mock.calls).toEqual([[2], [2]]);
      result.resolve(Response.json({ kind: 'result', createdTaskCount: 5 }));
      await running;
      expect(onTasksCreated.mock.calls).toEqual([[2], [2], [1]]);
      const calls = jest.mocked(fetchFn).mock.calls.length;
      await jest.advanceTimersByTimeAsync(4000);
      expect(jest.mocked(fetchFn).mock.calls).toHaveLength(calls);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts tasks created before a run error', async () => {
    const onTasksCreated = jest.fn();
    const { runner } = create(
      async () =>
        Response.json({
          kind: 'thrown',
          createdTaskCount: 3,
          error: { message: 'run failed' },
        }),
      { onTasksCreated }
    );
    await expect(runner.run()).rejects.toThrow('run failed');
    expect(onTasksCreated).toHaveBeenCalledWith(3);
  });
});

it.each([false, true])(
  'never dispatches to legacy business routes with a compatible health replica: %s',
  async (compatibleHealth) => {
    const business = jest.fn();
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (
        request.method === 'GET' &&
        request.url === TASK_PROCESS_PATHS.health &&
        compatibleHealth
      ) {
        response.end(
          JSON.stringify({
            protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
            capabilities: TASK_PROCESS_CAPABILITIES,
          })
        );
        return;
      }
      if (request.method === 'POST' && request.url === '/run') {
        business();
        response.end(JSON.stringify({ kind: 'result', result: { state: {} } }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const onDispatchFailure = jest.fn();
      const runner = new RemoteTaskRunner({
        route: { url: `http://127.0.0.1:${address.port}` },
        request: { taskType: 'test:legacy', taskInstance: {}, executionUuid: 'legacy-run' },
        timeoutMs: 1000,
        setCustomTaskRunEventFields: jest.fn(),
        onDispatchFailure,
      });
      const failure = await runner.run().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Legacy dispatch unexpectedly succeeded');
      expect(isUnrecoverableError(failure)).toBe(true);
      expect(business).not.toHaveBeenCalled();
      expect(paths).toEqual(
        compatibleHealth
          ? [TASK_PROCESS_PATHS.health, TASK_PROCESS_PATHS.run]
          : [TASK_PROCESS_PATHS.health]
      );
      expect(onDispatchFailure).toHaveBeenCalledWith(
        'test:legacy',
        compatibleHealth ? 'not_served' : 'incompatible',
        expect.any(String)
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
