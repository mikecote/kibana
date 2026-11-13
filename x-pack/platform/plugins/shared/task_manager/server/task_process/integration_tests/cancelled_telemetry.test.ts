/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ValueType } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import { fetch } from 'undici';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { startTaskProcessServer } from '../server';
import { RemoteWorkerSessions } from '../remote_worker_sessions';
import { acquireRemoteSession } from '../remote_supervisor_session';
import { cancelOverSession } from '../cancel_over_session';
import { TASK_PROCESS_SESSION_HEADER } from '../session_protocol';
import { TASK_PROCESS_PATHS, TASK_PROCESS_PROTOCOL_VERSION } from '../protocol';
import {
  accumulateTaskProcessMetrics,
  incrementCreatedTaskCount,
  requestDispatchTaskPool,
} from '../run_context';
import type { TaskProcessLease } from '../remote_task_runner';
import type { TaskProcessRunResponse } from '../wire';

it('retains overlapping cancelled telemetry independently, consumes/evicts it, and keeps bulk off WS', async () => {
  const token = 'cancel-telemetry-token';
  const logger = loggingSystemMock.createLogger();
  const sessions = new RemoteWorkerSessions(token, () => ({}), logger);
  const started = new Set<string>();
  const server = startTaskProcessServer({
    taskDefinitions: new Map(),
    kibanaVersion: '9.9.9',
    logger,
    authToken: token,
    port: 0,
    host: '127.0.0.1',
    getFeatureFlagDefinitions: () => ({}),
    registerRunCancellation: (get) => sessions.registerCancellation(get),
    prepareRunControl: (id, counter, signal, sessionId) =>
      sessions.prepareRun(sessionId, id, counter, signal),
    forwardRun: (request, { signal }) => {
      let finish = (): void => {};
      return {
        run: async () => {
          expect(await requestDispatchTaskPool()).toEqual(['current-main-task']);
          accumulateTaskProcessMetrics([
            {
              scope: { name: 'test.cancelled-bulk' },
              metrics: [
                {
                  descriptor: {
                    name: 'test.gauge',
                    description: 'Native telemetry',
                    unit: '1',
                    valueType: ValueType.DOUBLE,
                  },
                  aggregationTemporality: AggregationTemporality.CUMULATIVE,
                  dataPointType: DataPointType.GAUGE,
                  dataPoints: [
                    {
                      startTime: [0, 0],
                      endTime: [1, 0],
                      attributes: { execution: request.executionUuid, payload: 'x'.repeat(8192) },
                      value: 42,
                    },
                  ],
                },
              ],
            },
          ]);
          incrementCreatedTaskCount(3);
          started.add(request.executionUuid);
          await new Promise<void>((resolve) => {
            finish = resolve;
            signal?.addEventListener('abort', finish, { once: true });
            if (signal?.aborted) finish();
          });
          return { state: {} };
        },
        cancel: async () => finish(),
        cleanup: async () => signal?.removeEventListener('abort', finish),
      };
    },
  });
  sessions.attach(server);
  await once(server, 'listening');
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('No telemetry server address');
  const address = { url: `http://127.0.0.1:${bound.port}`, token };
  const leases: TaskProcessLease[] = [];
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await delay(10);
    }
    throw new Error('Telemetry lifecycle timed out');
  };
  const launch = async (id: string, grace: number, prepared?: TaskProcessLease) => {
    const lease =
      prepared ?? (await acquireRemoteSession(address, 'test', id, AbortSignal.timeout(5000)));
    if (!prepared) leases.push(lease);
    const progress = jest.fn();
    lease.bindCoordinator?.({
      reportProgress: progress,
      getCurrentTasksInPool: () => ['current-main-task'],
    });
    const running = fetch(`${address.url}${TASK_PROCESS_PATHS.run}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        [TASK_PROCESS_SESSION_HEADER]: lease.sessionId ?? '',
      },
      body: JSON.stringify({
        taskType: 'test',
        taskInstance: {},
        executionUuid: id,
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        cancelGracePeriodMs: grace,
      }),
    }).then(async (response) => (await response.json()) as TaskProcessRunResponse);
    await waitFor(() => started.has(id));
    return { lease, running, progress };
  };
  const metrics = (id: string) =>
    fetch(`${address.url}${TASK_PROCESS_PATHS.metrics}/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    const firstLease = await acquireRemoteSession(
      address,
      'test',
      'first',
      AbortSignal.timeout(5000)
    );
    leases.push(firstLease);
    const secondLease = await acquireRemoteSession(
      address,
      'test',
      'second',
      AbortSignal.timeout(5000)
    );
    leases.push(secondLease);
    const session = firstLease.session;
    if (!session) throw new Error('No authenticated control session');
    // Boot/flag acquisition is initialization; all typed work for both runs is counted below.
    const before = session.getTraffic();
    const first = await launch('first', 2000, firstLease);
    const second = await launch('second', 2000, secondLease);
    await delay(1100);
    expect(first.progress).toHaveBeenCalledWith(3);
    expect(second.progress).toHaveBeenCalledWith(3);
    const acknowledgements = await Promise.all([
      cancelOverSession(session, 'first', 1000),
      cancelOverSession(session, 'second', 1000),
    ]);
    expect(acknowledgements).toEqual([{ createdTaskCount: 3 }, { createdTaskCount: 3 }]);
    const completed = await Promise.all([first.running, second.running]);
    const after = session.getTraffic();
    expect(after.calls - before.calls).toBeLessThanOrEqual(10);
    expect(after.bytes - before.bytes).toBeLessThanOrEqual(5 * 1024);
    for (const [index, id] of ['first', 'second'].entries()) {
      const response = await metrics(id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ prometheus: completed[index].prometheus });
      expect(completed[index].prometheus?.encoded.length).toBeGreaterThan(8192);
      const consumed = await metrics(id);
      expect(consumed.status).toBe(404);
      await consumed.body?.cancel();
    }
    await waitFor(() => session.getStats().imports === 1 && session.getStats().exports === 1);
    const expired = await launch('expired', 100);
    await cancelOverSession(session, 'expired', 1000);
    await expired.running;
    await delay(150);
    const response = await metrics('expired');
    expect(response.status).toBe(404);
    await response.body?.cancel();
    process.stdout.write(
      `${JSON.stringify({
        remoteCancellation: {
          calls: after.calls - before.calls,
          bytes: after.bytes - before.bytes,
          telemetryBytes: completed.map(({ prometheus }) => prometheus?.encoded.length),
        },
      })}\n`
    );
  } finally {
    for (const lease of leases) lease.release();
    await sessions.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
