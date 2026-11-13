/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { expose } from '@kbn/core-remote-common';
import { openWebSocketSession } from '@kbn/core-remote-server-internal';
import type { IpcSession } from '@kbn/core-remote-server-internal';
import { CoordinatorCapabilities } from './coordinator_capabilities';
import type { CoordinatorCallbacks } from './coordinator_capabilities';
import type { RemoteWorkerCapabilities } from './remote_worker_capabilities';
import { TASK_PROCESS_SESSION_PATH } from './session_protocol';
import { parseTaskFeatureFlagDeclarations } from './feature_flag_declarations';
import { TaskProcessAcquireError } from './acquire_error';
import type { TaskProcessAddress, TaskProcessLease } from './remote_task_runner';

interface Connection {
  readonly session: IpcSession<RemoteWorkerCapabilities>;
  readonly id: string;
}
interface SharedSession {
  readonly opening: Promise<Connection>;
  readonly callbacks: Map<string, CoordinatorCallbacks>;
  readonly runs: Set<string>;
  readonly disconnected: AbortController;
  references: number;
  close(): void;
}
const sessions = new Map<string, SharedSession>();

const openSession = (address: TaskProcessAddress, key: string): SharedSession => {
  const url = new URL(address.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}${TASK_PROCESS_SESSION_PATH}`;
  const { WebSocket } = createRequire(__filename)('ws') as typeof import('ws');
  const socket = new WebSocket(url, {
    headers: address.token ? { authorization: `Bearer ${address.token}` } : {},
    handshakeTimeout: 5000,
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });
  const callbacks = new Map<string, CoordinatorCallbacks>();
  const disconnected = new AbortController();
  let liveSession: IpcSession<RemoteWorkerCapabilities> | undefined;
  const opening = (async (): Promise<Connection> => {
    let refused = (_request: ClientRequest, _response: IncomingMessage): void => {};
    const rejected = new Promise<never>((_resolve, reject) => {
      refused = (_request, response) => {
        const status = response.statusCode ?? 500;
        response.resume();
        reject(
          new TaskProcessAcquireError(
            status >= 500 ? 'unavailable' : status === 404 ? 'not_served' : 'incompatible',
            `Task worker session upgrade returned HTTP ${status}`
          )
        );
        socket.terminate();
      };
      socket.once('unexpected-response', refused);
    });
    try {
      await Promise.race([once(socket, 'open'), rejected]);
    } finally {
      socket.off('unexpected-response', refused);
    }
    const session = openWebSocketSession<RemoteWorkerCapabilities>(
      socket,
      'client',
      expose(new CoordinatorCapabilities((executionUuid) => callbacks.get(executionUuid)))
    );
    liveSession = session;
    try {
      const request = session.remote.id();
      try {
        return { session, id: await request };
      } finally {
        request[Symbol.dispose]();
      }
    } catch (error) {
      session.close();
      throw error;
    }
  })();
  const entry: SharedSession = {
    opening,
    callbacks,
    runs: new Set(),
    disconnected,
    references: 0,
    close: () => {
      if (liveSession) liveSession.close();
      else socket.terminate();
    },
  };
  socket.once('close', () => {
    callbacks.clear();
    disconnected.abort(new Error('Remote task control session disconnected'));
    if (sessions.get(key) === entry) sessions.delete(key);
  });
  void opening.catch(() => {
    if (sessions.get(key) === entry) sessions.delete(key);
    socket.terminate();
  });
  return entry;
};

/** Shares one authenticated session per busy remote supervisor and releases it after the last run. */
export const acquireRemoteSession = async (
  address: TaskProcessAddress,
  taskType: string,
  executionUuid: string,
  signal: AbortSignal
): Promise<TaskProcessLease> => {
  signal.throwIfAborted();
  const key = `${address.url}\0${address.token ?? ''}`;
  let entry = sessions.get(key);
  if (!entry) {
    entry = openSession(address, key);
    sessions.set(key, entry);
  }
  const shared = entry;
  if (shared.runs.has(executionUuid))
    throw new Error(`Duplicate remote task lease: ${executionUuid}`);
  shared.runs.add(executionUuid);
  shared.references++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    shared.callbacks.delete(executionUuid);
    shared.runs.delete(executionUuid);
    if (--shared.references === 0) {
      if (sessions.get(key) === shared) sessions.delete(key);
      shared.close();
    }
  };
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const connection = await Promise.race([shared.opening, aborted]);
    const declarations = connection.session.remote.featureFlags(taskType);
    let flags;
    try {
      flags = await Promise.race([Promise.resolve(declarations), aborted]);
    } finally {
      declarations[Symbol.dispose]();
    }
    if (!flags)
      throw new TaskProcessAcquireError('not_served', `Task worker does not serve ${taskType}`);
    const featureFlags = parseTaskFeatureFlagDeclarations(
      JSON.stringify({ taskType, featureFlags: flags }),
      taskType
    );
    return {
      ...address,
      sessionId: connection.id,
      session: connection.session,
      featureFlags,
      disconnected: shared.disconnected.signal,
      bindCoordinator: (callbacks) => {
        if (released || shared.disconnected.signal.aborted)
          throw new Error('Remote task lease is closed');
        shared.callbacks.set(executionUuid, callbacks);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};
