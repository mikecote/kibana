/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { fetch } from 'undici';
import { expose } from '@kbn/core-remote-common';
import { openWebSocketSession } from '@kbn/core-remote-server-internal';
import type { RunCoordinator } from '../run_coordinator';
import type { RemoteWorkerCapabilities } from '../remote_worker_capabilities';
import { REPO_ROOT } from '@kbn/repo-info';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { startTaskProcessWorker } from '../worker';
import { RemoteTaskRunner } from '../remote_task_runner';
import { acquireRemoteSession } from '../remote_supervisor_session';
import { elasticsearchConfigFromEnv } from '../es_config';
import { TASK_PROCESS_PROTOCOL_VERSION, TASK_PROCESS_PATHS } from '../protocol';
import { TASK_PROCESS_SESSION_HEADER } from '../session_protocol';
import { isRetryableError, isUnrecoverableError } from '../../task_running/errors';

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for remote session lifecycle');
};

describe('authenticated remote task sessions', () => {
  let directory: string;
  let worker: ReturnType<typeof startTaskProcessWorker>;
  let address: { url: string; token: string };
  const token = 'session-integration-token';
  const sockets = new Set<Duplex>();
  const snapshot: import('../wire').TaskProcessDispatchSnapshot = {
    protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
    init: {
      kibanaVersion: '9.9.9',
      elasticsearch: elasticsearchConfigFromEnv({
        ES_URL: 'http://127.0.0.1:1',
        ES_USERNAME: 'fixture',
        ES_PASSWORD: 'unused',
      }),
    },
    featureFlags: {},
  };
  const request = (executionUuid: string, complete = true) => ({
    executionUuid,
    taskType: 'session-test',
    kibanaVersion: '9.9.9',
    snapshot,
    taskInstance: { id: executionUuid, taskType: 'session-test', params: { complete }, state: {} },
  });

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'remote-session-worker-'));
    writeFileSync(
      join(directory, 'child.cjs'),
      [
        `require(${JSON.stringify(join(REPO_ROOT, 'src/setup_node_env'))});`,
        `require(${JSON.stringify(join(__dirname, '../testing/remote_session_child.ts'))});`,
      ].join('\n')
    );
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify({
        bundles: {
          test: { file: 'child.cjs', taskType: 'session-test', featureFlags: {} },
        },
      })
    );
    worker = startTaskProcessWorker({
      settings: { bundle_dir: directory, kibanaVersion: '9.9.9' },
      logger: loggingSystemMock.createLogger(),
      authToken: token,
      host: '127.0.0.1',
      port: 0,
    });
    worker.server.on('upgrade', (_request, socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    if (!worker.server.listening) await once(worker.server, 'listening');
    const bound = worker.server.address();
    if (!bound || typeof bound === 'string') throw new Error('No task worker address');
    address = { url: `http://127.0.0.1:${bound.port}`, token };
  });
  afterAll(async () => {
    await worker?.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    [{ authorization: 'Bearer incorrect' }, 401],
    [{ authorization: `Bearer ${token}`, origin: 'https://browser.invalid' }, 403],
  ] as const)('rejects unauthorized/browser WebSocket upgrades: %p', async (headers, expected) => {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${address.url.replace('http:', 'ws:')}/session`, { headers });
      socket.on('error', () => {});
      socket.once('open', () => {
        socket.close();
        reject(new Error('Unexpected upgrade'));
      });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
    });
    expect(status).toBe(expected);
    await waitFor(() => sockets.size === 0);
  });

  it('classifies rejected session authentication as incompatible rather than retrying it forever', async () => {
    const failure = await new RemoteTaskRunner({
      route: { ...address, token: 'incorrect' },
      request: request('bad-token'),
      timeoutMs: 5000,
      setCustomTaskRunEventFields: jest.fn(),
    })
      .run()
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Unauthorized session unexpectedly ran');
    expect(failure.message).toContain('session upgrade returned HTTP 401');
    expect(isUnrecoverableError(failure)).toBe(true);
    await waitFor(() => sockets.size === 0);
    expect(worker.getStats().spawned).toBe(0);
  });

  it('refuses a dispatch with no live session, including a formerly valid connection id', async () => {
    const lease = await acquireRemoteSession(
      address,
      'session-test',
      'race-lease',
      AbortSignal.timeout(5000)
    );
    const sessionId = lease.sessionId;
    lease.release();
    await waitFor(() => sockets.size === 0);
    for (const id of [undefined, sessionId]) {
      const response = await fetch(`${address.url}${TASK_PROCESS_PATHS.run}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(id ? { [TASK_PROCESS_SESSION_HEADER]: id } : {}),
        },
        body: JSON.stringify({
          ...request(`race-${String(id)}`),
          protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        kind: 'unavailable',
        reason: 'Task dispatch has no live control session',
      });
    }
    expect(worker.getStats()).toMatchObject({ active: 0, live: 0, spawned: 0 });
  });

  it('bounds dispatch setup when an authenticated session stalls its lease reply', async () => {
    const socket = new WebSocket(`${address.url.replace('http:', 'ws:')}/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await once(socket, 'open');
    const pending = Promise.withResolvers<RunCoordinator>();
    const session = openWebSocketSession<RemoteWorkerCapabilities>(
      socket,
      'client',
      expose(
        new (class {
          async forRun(): Promise<RunCoordinator> {
            return pending.promise;
          }
        })()
      )
    );
    try {
      const idRequest = session.remote.id();
      let id: string;
      try {
        id = await idRequest;
      } finally {
        idRequest[Symbol.dispose]();
      }
      const response = await fetch(`${address.url}${TASK_PROCESS_PATHS.run}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, [TASK_PROCESS_SESSION_HEADER]: id },
        body: JSON.stringify({
          ...request('stalled'),
          protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
          deadline: new Date(Date.now() + 100).toISOString(),
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        kind: 'unavailable',
        reason: expect.stringContaining('Task control session could not bind execution'),
      });
      pending.reject(new Error('Fixture lease aborted'));
      await waitFor(() => session.getStats().exports === 1);
      expect(worker.getStats()).toMatchObject({ active: 0, live: 0, spawned: 0 });
    } finally {
      session.close();
      await waitFor(() => sockets.size === 0);
    }
  });

  it('shares references, returns tables/listeners to baseline, and closes after the last release across bursts', async () => {
    const baselineListeners = worker.server.listenerCount('upgrade');
    for (let burst = 0; burst < 3; burst++) {
      const first = await acquireRemoteSession(
        address,
        'session-test',
        `first-${burst}`,
        AbortSignal.timeout(5000)
      );
      const second = await acquireRemoteSession(
        address,
        'session-test',
        `second-${burst}`,
        AbortSignal.timeout(5000)
      );
      expect(first.session).toBe(second.session);
      expect(sockets.size).toBe(1);
      expect(first.session?.getStats()).toEqual({ imports: 1, exports: 1 });
      first.release();
      expect(sockets.size).toBe(1);
      second.release();
      await waitFor(() => sockets.size === 0);
      expect(worker.server.listenerCount('upgrade')).toBe(baselineListeners);
    }
  });

  it('revokes a dropped session, retries normally, and leaves no orphaned native child', async () => {
    const pool = jest.fn(async () => ['main-active']);
    const failures = jest.fn();
    const runner = new RemoteTaskRunner({
      route: address,
      request: request('dropped', false),
      timeoutMs: 15000,
      getCurrentTasksInPool: pool,
      onDispatchFailure: failures,
      setCustomTaskRunEventFields: jest.fn(),
    });
    const failed = runner.run().then(
      () => {
        throw new Error('Dropped session unexpectedly succeeded');
      },
      (error: Error) => {
        expect(error.message).toContain('Task control session disconnected');
        expect(isRetryableError(error)).toBeInstanceOf(Date);
      }
    );
    await waitFor(() => pool.mock.calls.length > 0);
    expect(worker.getStats()).toMatchObject({ active: 1, live: 1 });
    expect(sockets.size).toBe(1);
    for (const socket of sockets) socket.destroy();
    await failed;
    expect(failures).toHaveBeenCalledWith(
      'session-test',
      'unavailable',
      'Task control session disconnected'
    );
    await waitFor(() => worker.getStats().live === 0);
    expect(worker.getStats().active).toBe(0);
    const counts = jest.fn();
    const result = await new RemoteTaskRunner({
      route: address,
      request: request('retry'),
      timeoutMs: 15000,
      getCurrentTasksInPool: pool,
      onTasksCreated: counts,
      setCustomTaskRunEventFields: jest.fn(),
    }).run();
    expect(result).toMatchObject({ state: { pool: ['main-active'], pid: expect.any(Number) } });
    expect(counts).toHaveBeenCalledWith(2);
    await waitFor(() => worker.getStats().live === 0 && sockets.size === 0);
  }, 30000);
  it('budgets a native remote run including its per-run flag read, pool, count and cancellation', async () => {
    const anchor = await acquireRemoteSession(
      address,
      'session-test',
      'budget-anchor',
      AbortSignal.timeout(5000)
    );
    const session = anchor.session;
    if (!session) throw new Error('No budget session');
    const before = session.getTraffic();
    const counts = jest.fn();
    const pool = jest.fn(async () => ['main-active']);
    const runner = new RemoteTaskRunner({
      route: address,
      request: request('budget-native', false),
      timeoutMs: 15000,
      getCurrentTasksInPool: pool,
      onTasksCreated: counts,
      setCustomTaskRunEventFields: jest.fn(),
    });
    const running = runner.run().then(
      () => {
        throw new Error('Cancelled native run unexpectedly succeeded');
      },
      (error: Error) => {
        expect(error.message).toContain('aborted');
        expect(isRetryableError(error)).not.toBeInstanceOf(Date);
      }
    );
    try {
      await waitFor(() => counts.mock.calls.length > 0);
      await runner.cancel();
      await running;
      expect(pool).toHaveBeenCalledTimes(1);
      expect(counts.mock.calls).toEqual([[2]]);
      await waitFor(() => session.getStats().imports === 1 && session.getStats().exports === 1);
      const after = session.getTraffic();
      expect(after.calls).toBeLessThanOrEqual(10);
      expect(after.bytes).toBeLessThanOrEqual(5 * 1024);
      expect(after.calls - before.calls).toBeLessThanOrEqual(10);
      expect(after.bytes - before.bytes).toBeLessThanOrEqual(5 * 1024);
      process.stdout.write(
        `${JSON.stringify({
          remoteNativeControl: {
            calls: after.calls,
            bytes: after.bytes,
            steadyCalls: after.calls - before.calls,
            steadyBytes: after.bytes - before.bytes,
            includesPerRunFlagRead: true,
          },
        })}\n`
      );
      await waitFor(() => worker.getStats().live === 0);
    } finally {
      await runner.cancel();
      anchor.release();
      await waitFor(() => sockets.size === 0);
    }
  }, 20000);
});
