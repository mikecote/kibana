/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { RpcSession } from 'capnweb';
import type { RpcCompatible } from 'capnweb';
import type WebSocket from 'ws';
import type { IpcSession } from './ipc_session';
import { WebSocketTransport } from './web_socket_transport';

/** Opens the fork-session contract over an already authenticated, open WebSocket. */
export const openWebSocketSession = <Remote extends RpcCompatible<Remote> = undefined>(
  socket: WebSocket,
  side: 'client' | 'server',
  localMain?: object
): IpcSession<Remote> => {
  const transport = new WebSocketTransport(socket, side);
  const session = new RpcSession<Remote>(transport, localMain);
  return {
    remote: session.getRemoteMain(),
    getStats: () => session.getStats(),
    drain: () => session.drain(),
    getTraffic: () => transport.getTraffic(),
    close: () => transport.abort(new Error('Remote WebSocket session ended')),
  };
};
