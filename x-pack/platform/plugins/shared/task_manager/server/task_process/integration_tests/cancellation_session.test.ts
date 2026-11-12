/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch } from 'undici';
import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { executionContextServiceMock } from '@kbn/core-execution-context-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { startTaskProcessServer } from '../server';
import { WorkerCapabilities } from '../worker_capabilities';
import type { GetRunCancellation } from '../worker_capabilities';
import { cancelOverSession } from '../cancel_over_session';
import { RemoteTaskRunner } from '../remote_task_runner';
import { sessionChannelPair } from '../testing/session_channel';
import {
  TASK_PROCESS_PATHS,
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
} from '../protocol';

// Boundary budget excludes worker-native ES reads, including cross-node cancellation reads.
const SEAM_BUDGET = { calls: 10, bytes: 5 * 1024 } as const;

describe('task process cancellation session', () => {
  it('budgets each run, acknowledges after cleanup, and returns tables to the post-boot baseline', async () => {
    const [mainChannel, childChannel] = sessionChannelPair();
    let getCancellation: GetRunCancellation = () => undefined;
    const childSession = openIpcSession(
      childChannel,
      expose(new WorkerCapabilities((id) => getCancellation(id)))
    );
    const mainSession = openIpcSession<WorkerCapabilities>(mainChannel);
    const order: string[] = [];
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
        const before = mainSession.getTraffic();
        const acknowledged = await cancelOverSession(mainSession, executionUuid, 1000);
        expect(acknowledged.createdTaskCount).toBe(0);
        expect(order.slice(-2)).toEqual(['cancel', 'cleanup']);
        expect((await response).status).toBe(200);
        await (await response).body?.cancel();
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
              tables: { main: mainSession.getStats(), child: childSession.getStats() },
            })}\n`
          );
        }
        expect(after.calls - before.calls).toBe(2);
        expect(after.calls - before.calls).toBeLessThanOrEqual(SEAM_BUDGET.calls);
        expect(after.bytes - before.bytes).toBeLessThanOrEqual(SEAM_BUDGET.bytes);
      }
      const retired = await fetch(`${url}${TASK_PROCESS_PATHS.cancel}run-0`, { method: 'POST' });
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
