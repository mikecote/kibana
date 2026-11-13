/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { startTaskProcessServer } from '../server';
import { WorkerCapabilities } from '../worker_capabilities';
import type { GetRunCancellation } from '../worker_capabilities';
import type { CoordinatorCapabilities } from '../coordinator_capabilities';
import { openWorkerRunControl } from '../worker_run_control';
import { TASK_PROCESS_CAPABILITIES, TASK_PROCESS_PROTOCOL_VERSION } from '../protocol';
import { requestDispatchTaskPool, incrementCreatedTaskCount } from '../run_context';
import type { TaskProcessInit } from '../wire';
import { createTaskProcessParentWatcher } from '../parent_watch';

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  log: () => {},
  isLevelEnabled: () => false,
  get: () => logger,
};
const send = process.send?.bind(process);
if (!send) throw new Error('Remote session fixture requires fork IPC');
const registerStop = createTaskProcessParentWatcher();
process.on('message', (init: TaskProcessInit) => {
  if (init.kind !== 'init') return;
  let getCancellation: GetRunCancellation = () => undefined;
  const session = openIpcSession<CoordinatorCapabilities>(
    {
      send,
      on: process.on.bind(process),
      off: process.off.bind(process),
    },
    expose(new WorkerCapabilities((id) => getCancellation(id)))
  );
  const server = startTaskProcessServer({
    executionContext: { withContext: (_context, run) => run() },
    taskDefinitions: new Map([
      [
        'session-test',
        {
          createTaskRunner: (context) => {
            let finish = (): void => {};
            return {
              run: async () => {
                const pool = await requestDispatchTaskPool();
                incrementCreatedTaskCount(2);
                if (!context.taskInstance.params.complete)
                  await new Promise<void>((resolve) => {
                    finish = resolve;
                    context.signal?.addEventListener('abort', finish, { once: true });
                    if (context.signal?.aborted) finish();
                  });
                return { state: { pool, pid: process.pid } };
              },
              cancel: async () => finish(),
              cleanup: async () => context.signal?.removeEventListener('abort', finish),
            };
          },
        },
      ],
    ]),
    kibanaVersion: init.kibanaVersion,
    authToken: init.authToken,
    getFeatureFlagDefinitions: () => ({}),
    registerRunCancellation: (get) => {
      getCancellation = get;
    },
    prepareRunControl: (id, counter, signal) => openWorkerRunControl(session, id, counter, signal),
    host: '127.0.0.1',
    port: 0,
    logger,
    onListening: (port) =>
      send({
        kind: 'ready',
        port,
        featureFlags: {},
        protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
        capabilities: TASK_PROCESS_CAPABILITIES,
      }),
    onShutdown: async () => session.close(),
  });
  registerStop(async () => {
    session.close();
    server.closeAllConnections();
    server.close();
  });
});
