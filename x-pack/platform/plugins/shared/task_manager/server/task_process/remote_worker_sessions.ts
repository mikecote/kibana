/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import type { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { expose } from '@kbn/core-remote-common';
import { openWebSocketSession } from '@kbn/core-remote-server-internal';
import type { IpcSession } from '@kbn/core-remote-server-internal';
import type { Logger } from '@kbn/logging';
import { RemoteWorkerCapabilities } from './remote_worker_capabilities';
import { TASK_PROCESS_SESSION_PATH } from './session_protocol';
import type { GetRunCancellation } from './worker_capabilities';
import type { CoordinatorCapabilities } from './coordinator_capabilities';
import type { TaskFeatureFlagDefinitions } from './feature_flag_declarations';
import type { AdHocTaskCounter } from '../lib/adhoc_task_counter';
import { openWorkerRunControl } from './worker_run_control';
import type { WorkerRunControl } from './worker_run_control';
import { TaskProcessAcquireError } from './acquire_error';
import { isTaskProcessAuthorized } from './task_process_auth';

interface Connection {
  readonly socket: WebSocket;
  readonly session: IpcSession<CoordinatorCapabilities>;
  readonly runs: Set<string>;
}

/** Binds authenticated remote dispatch to its session; a lost session revokes only its owned work. */
export class RemoteWorkerSessions {
  private readonly sockets: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly cancelling = new Set<Promise<void>>();
  private getCancellation: GetRunCancellation = () => undefined;
  private server?: Server;

  constructor(
    private readonly token: string,
    private readonly getFeatureFlags: (taskType: string) => TaskFeatureFlagDefinitions | undefined,
    private readonly logger: Logger
  ) {
    const { WebSocketServer: Server } = createRequire(__filename)('ws') as typeof import('ws');
    this.sockets = new Server({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
  }

  registerCancellation(getCancellation: GetRunCancellation): void {
    this.getCancellation = getCancellation;
  }

  attach(server: Server): void {
    this.server = server;
    server.on('upgrade', this.upgrade);
  }

  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const status =
      request.url !== TASK_PROCESS_SESSION_PATH
        ? '404 Not Found'
        : request.headers.origin !== undefined
        ? '403 Forbidden'
        : !isTaskProcessAuthorized(request, this.token)
        ? '401 Unauthorized'
        : undefined;
    if (status) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
      const id = randomUUID();
      const runs = new Set<string>();
      const root = new RemoteWorkerCapabilities(
        (executionUuid) =>
          runs.has(executionUuid) ? this.getCancellation(executionUuid) : undefined,
        id,
        this.getFeatureFlags
      );
      const connection = {
        socket: webSocket,
        runs,
        session: openWebSocketSession<CoordinatorCapabilities>(webSocket, 'server', expose(root)),
      };
      this.connections.set(id, connection);
      webSocket.once('close', () => this.disconnect(id, connection));
    });
  };

  private disconnect(id: string, connection: Connection): void {
    if (!this.connections.delete(id)) return;
    connection.session.close();
    const cancellation = Promise.allSettled(
      [...connection.runs].map(async (executionUuid) => {
        await this.getCancellation(executionUuid)?.();
      })
    ).then((results) => {
      for (const result of results)
        if (result.status === 'rejected')
          this.logger.debug(
            `Disconnected task session cancellation failed: ${String(result.reason)}`
          );
    });
    this.cancelling.add(cancellation);
    void cancellation.finally(() => this.cancelling.delete(cancellation));
  }

  async prepareRun(
    sessionId: string | undefined,
    executionUuid: string,
    counter: AdHocTaskCounter,
    signal: AbortSignal
  ): Promise<WorkerRunControl> {
    const connection = sessionId ? this.connections.get(sessionId) : undefined;
    if (!connection)
      throw new TaskProcessAcquireError('unavailable', 'Task dispatch has no live control session');
    connection.runs.add(executionUuid);
    try {
      const control = await openWorkerRunControl(
        connection.session,
        executionUuid,
        counter,
        signal
      );
      return {
        ...control,
        dispose: async () => {
          try {
            await control.dispose();
          } finally {
            connection.runs.delete(executionUuid);
          }
        },
      };
    } catch (error) {
      connection.runs.delete(executionUuid);
      throw new TaskProcessAcquireError(
        'unavailable',
        `Task control session could not bind execution: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async stop(): Promise<void> {
    this.server?.off('upgrade', this.upgrade);
    for (const [id, connection] of this.connections) {
      this.disconnect(id, connection);
      connection.socket.terminate();
    }
    await Promise.all(this.cancelling);
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
  }
}
