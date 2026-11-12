/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { encodeMetricScopes } from '@kbn/metrics';
import { WorkerCapabilities } from './worker_capabilities';
import { RemoteTaskRunner } from './remote_task_runner';
import { sessionChannelPair } from './testing/session_channel';
import {
  TASK_PROCESS_CAPABILITIES,
  TASK_PROCESS_PATHS,
  TASK_PROCESS_PROTOCOL_VERSION,
} from './protocol';

it('receives cancellation telemetry over native HTTP rather than the control capability', async () => {
  const [mainChannel, childChannel] = sessionChannelPair();
  const prometheus = { sequence: 1, encoded: encodeMetricScopes([]) };
  const childSession = openIpcSession(
    childChannel,
    expose(new WorkerCapabilities(() => async () => ({ createdTaskCount: 1, prometheus })))
  );
  const mainSession = openIpcSession<WorkerCapabilities>(mainChannel);
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const onMetrics = jest.fn();
  const onTasksCreated = jest.fn();
  const release = jest.fn();
  const fetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (input, options) => {
      const url = String(input);
      if (url.endsWith(TASK_PROCESS_PATHS.health))
        return new Response(
          JSON.stringify({
            protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
            capabilities: TASK_PROCESS_CAPABILITIES,
          })
        );
      if (url.endsWith(`${TASK_PROCESS_PATHS.metrics}native-cancel`))
        return new Response(JSON.stringify({ prometheus }));
      if (url.endsWith(TASK_PROCESS_PATHS.run)) {
        started.resolve();
        return new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          })
        );
      }
      throw new Error(`Unexpected control HTTP request: ${url}`);
    }
  );
  const runner = new RemoteTaskRunner({
    route: { acquire: async () => ({ url: 'http://worker', session: mainSession, release }) },
    request: {
      taskType: 'test',
      executionUuid: 'native-cancel',
      taskInstance: {},
      cancelGracePeriodMs: 1000,
    },
    timeoutMs: 5000,
    signal: abort.signal,
    setCustomTaskRunEventFields: jest.fn(),
    fetchFn,
    onMetrics,
    onTasksCreated,
  });
  try {
    const running = runner.run().catch(() => undefined);
    await started.promise;
    abort.abort();
    await running;
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics).toHaveBeenCalledWith([]);
    expect(onTasksCreated).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith({ force: true });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      `http://worker${TASK_PROCESS_PATHS.health}`,
      `http://worker${TASK_PROCESS_PATHS.run}`,
      `http://worker${TASK_PROCESS_PATHS.metrics}native-cancel`,
    ]);
    expect(mainSession.getTraffic().calls).toBe(2);
  } finally {
    mainSession.close();
    childSession.close();
  }
});
