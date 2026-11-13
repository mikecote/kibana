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

import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import type { IpcSession } from '@kbn/core-remote-server-internal';
import { sessionChannelPair } from './testing/session_channel';
import { WorkerCapabilities } from './worker_capabilities';
import type { GetRunCancellation } from './worker_capabilities';
import { CoordinatorCapabilities } from './coordinator_capabilities';
import type { CoordinatorCallbacks } from './coordinator_capabilities';
import { openWorkerRunControl } from './worker_run_control';
import { RemoteWorkerSessions } from './remote_worker_sessions';
import { acquireRemoteSession } from './remote_supervisor_session';
import { TASK_PROCESS_SESSION_HEADER } from './session_protocol';
import { decodeMetricResources } from '@kbn/metrics';
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
import type { TaskFeatureFlagDefinitions } from './feature_flag_declarations';
import { RemoteTaskRunner } from './remote_task_runner';
import { elasticsearchConfigFromEnv } from './es_config';
import { TaskProcessSupervisor } from './supervisor';
import { startTaskProcessWorker } from './worker';
import type { TaskProcessDispatchSnapshot } from './wire';
import type { TaskExecutionPool } from '../task_scheduling';
import { createHostFeatureFlags, requestDispatchTaskPool, registerRunFlusher } from './run_context';
import { firstValueFrom } from 'rxjs';
import type { FakeRequestEnricher } from '@kbn/core-security-server';

const TYPE = 'test:type';
const TOKEN = 'secret';

describe('task process server', () => {
  let mainSession: IpcSession<WorkerCapabilities>;
  let childSession: IpcSession<CoordinatorCapabilities>;
  let coordinator: CoordinatorCallbacks | undefined;

  let server: Server;
  let url: string;
  const cleanup = jest.fn();
  const collectGauges = jest.fn(async () => []);
  const getFeatureFlagDefinitions = jest.fn(
    (_type: string): TaskFeatureFlagDefinitions | undefined => ({ 'sdk.enabled': false })
  );
  const flush = jest.fn();
  const order: string[] = [];
  let createTask: (context: RunContext) => CancellableTask;
  let runAsDefinition: TaskRunAsDefinition | undefined;
  let enrichFakeRequest: jest.MockedFunction<FakeRequestEnricher>;

  beforeEach(async () => {
    runAsDefinition = undefined;
    coordinator = undefined;
    let getCancellation: GetRunCancellation = () => undefined;
    const [mainChannel, childChannel] = sessionChannelPair();
    // Direct HTTP validation tests use fixture callbacks; leased runs bind their actual callbacks.
    mainSession = openIpcSession<WorkerCapabilities>(
      mainChannel,
      expose(
        new CoordinatorCapabilities(
          () => coordinator ?? { reportProgress: () => {}, getCurrentTasksInPool: async () => [] }
        )
      )
    );
    childSession = openIpcSession<CoordinatorCapabilities>(
      childChannel,
      expose(new WorkerCapabilities((id) => getCancellation(id)))
    );

    collectGauges.mockClear();
    getFeatureFlagDefinitions.mockReset().mockReturnValue({});
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
      registerRunCancellation: (get) => {
        getCancellation = get;
      },
      prepareRunControl: (id, counter, signal) =>
        openWorkerRunControl(childSession, id, counter, signal),

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
      collectGauges,
      getFeatureFlagDefinitions,
      enrichFakeRequest,
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(() => {
    mainSession.close();
    childSession.close();
    server.close();
    server.closeAllConnections();
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
      route: {
        acquire: async () => ({
          url,
          token: overrides.token ?? TOKEN,
          session: mainSession,
          bindCoordinator: (callbacks) => {
            coordinator = callbacks;
          },
          release: () => {
            coordinator = undefined;
          },
        }),
      },
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

  it('authenticates gauge collection and bounds its owner before invoking the native source', async () => {
    const endpoint = `${url}${TASK_PROCESS_PATHS.metrics}`;
    expect((await undiciFetch(`${endpoint}?owner=node`)).status).toBe(401);
    expect(collectGauges).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer ${TOKEN}` };
    const response = await undiciFetch(`${endpoint}?owner=node`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('encoded' in body) ||
      typeof body.encoded !== 'string'
    ) {
      throw new Error('The native gauge response has no metric payload');
    }
    expect(decodeMetricResources(body.encoded)).toEqual([]);
    expect(collectGauges).toHaveBeenCalledWith('node');
    for (const owner of ['', 'x'.repeat(129)]) {
      const invalid = await undiciFetch(`${endpoint}?owner=${owner}`, { headers });
      expect(invalid.status).toBe(400);
      await invalid.body?.cancel();
    }
    expect(collectGauges).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { 'sdk.enabled': 'false' }])(
    'refuses unevaluated native flags before creating a task: %p',
    async (featureFlags) => {
      getFeatureFlagDefinitions.mockReturnValue({ 'sdk.enabled': false });
      const create = jest.fn(() => ({ run: async () => ({ state: {} }) }));
      createTask = create;
      const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
          taskType: TYPE,
          taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
          executionUuid: 'unnegotiated-flags',
          featureFlags,
        }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        kind: 'incompatible',
        reason: expect.stringContaining('sdk.enabled'),
      });
      expect(create).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(flush).not.toHaveBeenCalled();
    }
  );

  it('refuses a forwarded snapshot whose flag values differ before forwarding business work', async () => {
    const forwardRun = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    const gateway = startTaskProcessServer({
      taskDefinitions: new Map(),
      forwardRun,
      getFeatureFlagDefinitions: () => ({ 'sdk.enabled': false }),
      port: 0,
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: '9.9.9',
      authToken: TOKEN,
    });
    await new Promise<void>((resolve) => gateway.once('listening', resolve));
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('The gateway has no TCP address');
    try {
      const response = await undiciFetch(
        `http://127.0.0.1:${address.port}${TASK_PROCESS_PATHS.run}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
            taskType: TYPE,
            taskInstance: { id: 't1', taskType: TYPE, params: {}, state: {} },
            executionUuid: 'inconsistent-flags',
            featureFlags: { 'sdk.enabled': false },
            snapshot: { featureFlags: { 'sdk.enabled': true } },
          }),
        }
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        kind: 'incompatible',
        reason: 'Run and dispatch snapshot feature flags disagree',
      });
      expect(forwardRun).not.toHaveBeenCalled();
    } finally {
      gateway.close();
    }
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
    jest
      .spyOn(TaskProcessSupervisor.prototype, 'getFeatureFlagDefinitions')
      .mockReturnValue({ 'test.flag': false });
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
        getFeatureFlags: async () => current.featureFlags,
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
    // Session setup is not the assertion target: missing dispatch snapshot validation is.
    const lease = await acquireRemoteSession(
      { url, token: TOKEN },
      TYPE,
      'missing',
      AbortSignal.timeout(5000)
    );
    lease.bindCoordinator?.({ reportProgress: () => {} });
    const response = await undiciFetch(`${url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        [TASK_PROCESS_SESSION_HEADER]: lease.sessionId ?? '',
      },
      body: JSON.stringify({
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        taskType: TYPE,
        taskInstance: {},
        executionUuid: 'missing',
        featureFlags: { 'test.flag': false },
      }),
    });
    expect(await response.json()).toMatchObject({ kind: 'thrown' });
    expect(acquire).not.toHaveBeenCalled();
    lease.release();
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
      route: { acquire: async () => ({ url: 'http://process', release: jest.fn() }) },
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

  it('counts monotonic typed checkpoints and the final total once, without polling control HTTP', async () => {
    jest.useFakeTimers();
    try {
      const result = Promise.withResolvers<Response>();
      const onTasksCreated = jest.fn();
      let report = (_count: number): void => {};
      const fetchFn: typeof fetch = jest.fn(async () => result.promise);
      const { runner } = create(fetchFn, {
        onTasksCreated,
        timeoutMs: 10000,
        route: {
          acquire: async () => ({
            url: 'http://process',
            release: jest.fn(),
            bindCoordinator: (callbacks) => {
              report = callbacks.reportProgress;
            },
          }),
        },
      });
      const running = runner.run();
      await jest.advanceTimersByTimeAsync(0);
      for (const count of [2, 2, 1, 4]) report(count);
      expect(onTasksCreated.mock.calls).toEqual([[2], [2]]);
      result.resolve(Response.json({ kind: 'result', createdTaskCount: 5 }));
      await running;
      expect(onTasksCreated.mock.calls).toEqual([[2], [2], [1]]);
      const calls = jest.mocked(fetchFn).mock.calls.length;
      await jest.advanceTimersByTimeAsync(4000);
      expect(jest.mocked(fetchFn).mock.calls).toHaveLength(calls);
      expect(
        jest
          .mocked(fetchFn)
          .mock.calls.every(([url]) => String(url).endsWith(TASK_PROCESS_PATHS.run))
      ).toBe(true);
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

it.each([
  { compatibleHealth: false, legacyRun: '/run' },
  { compatibleHealth: true, legacyRun: '/run' },
  { compatibleHealth: false, legacyRun: '/v2/run' },
  { compatibleHealth: true, legacyRun: '/v2/run' },
])(
  'never dispatches to $legacyRun with a compatible health replica: $compatibleHealth',
  async ({ compatibleHealth, legacyRun }) => {
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
      if (request.method === 'POST' && request.url === legacyRun) {
        business();
        response.end(JSON.stringify({ kind: 'result', result: { state: {} } }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    });
    const sessions = new RemoteWorkerSessions(TOKEN, () => ({}), loggingSystemMock.createLogger());
    sessions.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const onDispatchFailure = jest.fn();
      const runner = new RemoteTaskRunner({
        route: { url: `http://127.0.0.1:${address.port}`, token: TOKEN },
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
      await sessions.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
