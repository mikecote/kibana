/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch } from 'undici';
import { ValueType } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import type { ScopeMetrics } from '@kbn/metrics';
import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { executionContextServiceMock } from '@kbn/core-execution-context-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { startTaskProcessServer } from '../server';
import { WorkerCapabilities } from '../worker_capabilities';
import type { GetRunCancellation } from '../worker_capabilities';
import { cancelOverSession } from '../cancel_over_session';
import { RemoteTaskRunner } from '../remote_task_runner';
import { CoordinatorCapabilities } from '../coordinator_capabilities';
import type { CoordinatorCallbacks } from '../coordinator_capabilities';
import { openWorkerRunControl } from '../worker_run_control';
import type { TaskFeatureFlagDefinitions } from '../feature_flag_declarations';
import { incrementCreatedTaskCount, requestDispatchTaskPool } from '../run_context';
import { AdHocTaskCounter } from '../../lib/adhoc_task_counter';
import { sessionChannelPair } from '../testing/session_channel';
import {
  TASK_PROCESS_PATHS,
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
} from '../protocol';

// RPC budget excludes native ES reads and the native HTTP telemetry data plane.
const SEAM_BUDGET = { calls: 10, bytes: 5 * 1024 } as const;

describe('task process cancellation session', () => {
  it('budgets each run, acknowledges after cleanup, and returns tables to the post-boot baseline', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    let getCancellation: GetRunCancellation = () => undefined;
    const callbacks = new Map<string, CoordinatorCallbacks>();
    const childSession = openIpcSession<CoordinatorCapabilities>(
      childChannel,
      expose(new WorkerCapabilities((id) => getCancellation(id)))
    );
    const mainSession = openIpcSession<WorkerCapabilities>(
      mainChannel,
      expose(new CoordinatorCapabilities((id) => callbacks.get(id)))
    );
    const order: string[] = [];
    const nativeScopes: ScopeMetrics[] = [
      {
        scope: { name: 'test.native-telemetry' },
        metrics: [
          {
            descriptor: {
              name: 'test.gauge',
              description: 'Bulk telemetry stays native',
              unit: '1',
              valueType: ValueType.DOUBLE,
            },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.GAUGE,
            dataPoints: [
              {
                startTime: [0, 0],
                endTime: [1, 0],
                attributes: { payload: 'x'.repeat(8192) },
                value: 42,
              },
            ],
          },
        ],
      },
    ];
    const collectMetrics = jest.fn(async () => nativeScopes);
    let started = () => {};
    const server = startTaskProcessServer({
      executionContext: executionContextServiceMock.createSetupContract(),
      taskDefinitions: new Map([
        [
          'test',
          {
            createTaskRunner: () => {
              let finish = () => {};
              const finished = new Promise<void>((resolve) => {
                finish = resolve;
              });
              return {
                run: async () => {
                  expect(await requestDispatchTaskPool()).toEqual(['main-task']);
                  incrementCreatedTaskCount(2);
                  started();
                  await finished;
                  return { state: {} };
                },
                cancel: async () => {
                  order.push('cancel');
                  finish();
                },
                cleanup: async () => {
                  order.push('cleanup');
                },
              };
            },
          },
        ],
      ]),
      port: 0,
      host: '127.0.0.1',
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: '9.9.9',
      getFeatureFlagDefinitions: () => ({}),
      collectMetrics,
      prepareRunControl: (id, counter, signal) =>
        openWorkerRunControl(childSession, id, counter, signal),
      registerRunCancellation: (get) => {
        getCancellation = get;
      },
    });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Task server did not listen');
      const url = `http://127.0.0.1:${address.port}`;
      const localBaseline = mainSession.getStats();
      const remoteBaseline = childSession.getStats();
      for (let run = 0; run < 3; run++) {
        const executionUuid = `run-${run}`;
        let onProgress = () => {};
        const published = new Promise<void>((resolve) => {
          onProgress = resolve;
        });
        callbacks.set(executionUuid, {
          getCurrentTasksInPool: () => ['main-task'],
          reportProgress: (createdTaskCount) => {
            expect(createdTaskCount).toBe(2);
            onProgress();
          },
        });
        const before = mainSession.getTraffic();
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        const response = fetch(`${url}${TASK_PROCESS_PATHS.run}`, {
          method: 'POST',
          body: JSON.stringify({
            protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
            taskType: 'test',
            executionUuid,
            taskInstance: { id: executionUuid, taskType: 'test', params: {}, state: {} },
          }),
        });
        await running;
        let progressCallBytes = 0;
        if (run === 0) {
          await delay(10);
          const beforeProgress = mainSession.getTraffic();
          await published;
          await delay(10);
          const afterProgress = mainSession.getTraffic();
          expect(afterProgress.calls - beforeProgress.calls).toBe(1);
          progressCallBytes = afterProgress.bytes - beforeProgress.bytes;
          expect(collectMetrics).not.toHaveBeenCalled();
          const activeTelemetry = await fetch(
            `${url}${TASK_PROCESS_PATHS.metrics}/${executionUuid}`
          );
          expect(activeTelemetry.status).toBe(200);
          expect(Object.keys((await activeTelemetry.json()) as object)).toEqual(['prometheus']);
          await delay(1100);
          expect(mainSession.getTraffic().calls).toBe(afterProgress.calls);
          expect(collectMetrics).toHaveBeenCalledTimes(1);
          for (const [method, path] of [
            ['GET', '/v3/feature_flags?taskType=test'],
            ['GET', '/v3/gauges?owner=node'],
            ['POST', `/v3/active_pool/${executionUuid}`],
          ]) {
            const retired = await fetch(`${url}${path}`, { method });
            expect(retired.status).toBe(404);
            await retired.body?.cancel();
          }
        }
        const acknowledged = await cancelOverSession(mainSession, executionUuid, 1000);
        expect(acknowledged.createdTaskCount).toBe(2);
        expect(acknowledged).not.toHaveProperty('prometheus');
        expect(order.slice(-2)).toEqual(['cancel', 'cleanup']);
        expect((await response).status).toBe(200);
        await (await response).body?.cancel();
        const telemetry = await fetch(`${url}${TASK_PROCESS_PATHS.metrics}/${executionUuid}`);
        expect(telemetry.status).toBe(200);
        const nativeBody = await telemetry.text();
        expect(Object.keys(JSON.parse(nativeBody))).toEqual(['prometheus']);
        expect(Buffer.byteLength(nativeBody)).toBeGreaterThan(SEAM_BUDGET.bytes);
        callbacks.delete(executionUuid);
        await mainSession.drain();
        const deadline = Date.now() + 1000;
        while (
          Date.now() < deadline &&
          (JSON.stringify(mainSession.getStats()) !== JSON.stringify(localBaseline) ||
            JSON.stringify(childSession.getStats()) !== JSON.stringify(remoteBaseline))
        )
          await delay(10);
        expect(mainSession.getStats()).toEqual(localBaseline);
        expect(childSession.getStats()).toEqual(remoteBaseline);
        const after = mainSession.getTraffic();
        if (process.env.KBN_REMOTE_SEAM_LOG) {
          process.stdout.write(
            `${JSON.stringify({
              name: 'task-process-seam-budget',
              run,
              calls: after.calls - before.calls,
              bytes: after.bytes - before.bytes,
              nativeTelemetryBytes: Buffer.byteLength(nativeBody),
              progressCallBytes,
              tables: { main: mainSession.getStats(), child: childSession.getStats() },
            })}\n`
          );
        }
        expect(after.calls - before.calls).toBe(run === 0 ? 5 : 4);
        expect(after.calls - before.calls).toBeLessThanOrEqual(SEAM_BUDGET.calls);
        expect(after.bytes - before.bytes).toBeLessThanOrEqual(SEAM_BUDGET.bytes);
      }
      const retired = await fetch(`${url}/v3/cancel/run-0`, { method: 'POST' });
      expect(retired.status).toBe(404);
      await retired.body?.cancel();
      await expect(mainSession.remote.forRun('not-active')).rejects.toThrow(
        'No active task execution'
      );
    } finally {
      mainSession.close();
      childSession.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts a pending pool read and releases its scoped capability handles', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    const mainSession = openIpcSession(
      mainChannel,
      expose(
        new CoordinatorCapabilities(() => ({
          getCurrentTasksInPool: () => new Promise(() => {}),
          reportProgress: () => {},
        }))
      )
    );
    const childSession = openIpcSession<CoordinatorCapabilities>(childChannel);
    const abort = new AbortController();
    const baseline = { main: mainSession.getStats(), child: childSession.getStats() };
    try {
      const control = await openWorkerRunControl(
        childSession,
        'pool',
        new AdHocTaskCounter(),
        abort.signal
      );
      const pending = control.getCurrentTasksInPool();
      abort.abort();
      await expect(pending).rejects.toThrow('aborted');
      await control.dispose();
      const deadline = Date.now() + 1000;
      while (
        Date.now() < deadline &&
        JSON.stringify({ main: mainSession.getStats(), child: childSession.getStats() }) !==
          JSON.stringify(baseline)
      )
        await delay(10);
      expect({ main: mainSession.getStats(), child: childSession.getStats() }).toEqual(baseline);
    } finally {
      mainSession.close();
      childSession.close();
    }
  });

  it('uses ready declarations for local flags with no HTTP preflight or replacement RPC', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    const childSession = openIpcSession(childChannel);
    const mainSession = openIpcSession<WorkerCapabilities>(mainChannel);
    const getFeatureFlags = jest.fn(
      async (_taskType: string, _declarations?: TaskFeatureFlagDefinitions) => ({
        'sdk.enabled': true,
      })
    );
    const fetchFn = jest.fn<ReturnType<typeof global.fetch>, Parameters<typeof global.fetch>>(
      async (url) => {
        if (String(url).endsWith(TASK_PROCESS_PATHS.health))
          return new Response(
            JSON.stringify({
              protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
              capabilities: TASK_PROCESS_CAPABILITIES,
            })
          );
        if (String(url).endsWith(TASK_PROCESS_PATHS.run))
          return new Response(
            JSON.stringify({ kind: 'result', result: { state: {} }, createdTaskCount: 0 })
          );
        throw new Error(`Unexpected HTTP control request: ${url}`);
      }
    );
    const runner = new RemoteTaskRunner({
      route: {
        acquire: async () => ({
          url: 'http://worker',
          session: mainSession,
          featureFlags: { 'sdk.enabled': false },
          release: jest.fn(),
        }),
      },
      request: {
        taskType: 'test',
        executionUuid: 'flags',
        taskInstance: { id: 'flags', params: {}, state: {} },
      },
      timeoutMs: 5000,
      setCustomTaskRunEventFields: jest.fn(),
      getFeatureFlags,
      fetchFn,
    });
    try {
      await runner.run();
      expect(getFeatureFlags).toHaveBeenCalledWith('test', { 'sdk.enabled': false });
      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
        `http://worker${TASK_PROCESS_PATHS.health}`,
        `http://worker${TASK_PROCESS_PATHS.run}`,
      ]);
      expect(JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).featureFlags).toEqual({
        'sdk.enabled': true,
      });
      expect(mainSession.getTraffic()).toEqual({ calls: 0, bytes: 0, messages: 0 });
    } finally {
      mainSession.close();
      childSession.close();
    }
  });

  it('forces lease retirement after the RPC grace bound without calling the HTTP cancel endpoint', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    const childSession = openIpcSession(
      childChannel,
      expose(new WorkerCapabilities(() => () => new Promise(() => {})))
    );
    const mainSession = openIpcSession<WorkerCapabilities>(mainChannel);
    const release = jest.fn();
    const abort = new AbortController();
    let onStarted = () => {};
    const started = new Promise<void>((resolve) => {
      onStarted = resolve;
    });
    const fetchFn = jest.fn<ReturnType<typeof global.fetch>, Parameters<typeof global.fetch>>(
      (url, options) => {
        if (String(url).endsWith(TASK_PROCESS_PATHS.health)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
                capabilities: TASK_PROCESS_CAPABILITIES,
              })
            )
          );
        }
        onStarted();
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Run aborted')), {
            once: true,
          });
        });
      }
    );
    const runner = new RemoteTaskRunner({
      route: { acquire: async () => ({ url: 'http://worker', session: mainSession, release }) },
      request: {
        taskType: 'test',
        executionUuid: 'unresponsive',
        taskInstance: { id: 'test', params: {}, state: {} },
        cancelGracePeriodMs: 10,
      },
      timeoutMs: 5000,
      signal: abort.signal,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn,
    });
    try {
      const running = runner.run().catch(() => undefined);
      await started;
      abort.abort();
      await running;
      expect(release).toHaveBeenCalledWith({ force: true });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
        `http://worker${TASK_PROCESS_PATHS.health}`,
        `http://worker${TASK_PROCESS_PATHS.run}`,
      ]);
    } finally {
      mainSession.close();
      childSession.close();
    }
  });

  it('exposes no run capability during boot and bounds an unresponsive cancellation', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    let getCancellation: GetRunCancellation = () => undefined;
    const childSession = openIpcSession(
      childChannel,
      expose(new WorkerCapabilities((id) => getCancellation(id)))
    );
    const mainSession = openIpcSession<WorkerCapabilities>(mainChannel);
    try {
      await expect(mainSession.remote.forRun('before-ready')).rejects.toThrow(
        'No active task execution'
      );
      getCancellation = () => () => new Promise(() => {});
      await expect(cancelOverSession(mainSession, 'unresponsive', 10)).rejects.toThrow(
        'grace period expired'
      );
    } finally {
      mainSession.close();
      childSession.close();
    }
  });
});
