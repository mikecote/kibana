/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { expose } from '@kbn/core-remote-common';
import { openWebSocketSession } from './web_socket_session';
import type { IpcSession } from './ipc_session';
import { Counter } from './__fixtures__/web_socket_counter';

class Root {
  counter(): Counter {
    return new Counter();
  }
}

it('restores tables and removes transport listeners across three real WebSocket bursts', async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  const sessions: Array<IpcSession<Root>> = [];
  const peers: WebSocket[] = [];
  sockets.on('connection', (socket) => {
    peers.push(socket);
    sessions.push(openWebSocketSession<Root>(socket, 'server', expose(new Root())));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No WebSocket address');
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
      await once(socket, 'open');
      const session = openWebSocketSession<Root>(socket, 'client', expose(new Root()));
      const peer = sessions[cycle];
      const baseline = { local: session.getStats(), peer: peer.getStats() };
      const request = session.remote.counter();
      const counter = await request.dup();
      request[Symbol.dispose]();
      expect(await counter.add(1)).toBe(1);
      expect(await counter.add(2)).toBe(3);
      counter[Symbol.dispose]();
      await session.drain();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          JSON.stringify({ local: session.getStats(), peer: peer.getStats() }) ===
          JSON.stringify(baseline)
        )
          break;
        await delay(10);
      }
      expect({ local: session.getStats(), peer: peer.getStats() }).toEqual(baseline);
      expect(session.getTraffic().calls).toBeLessThanOrEqual(10);
      expect(session.getTraffic().bytes).toBeLessThanOrEqual(5 * 1024);
      const closed = once(socket, 'close');
      const peerClosed = once(peers[cycle], 'close');
      session.close();
      await Promise.all([closed, peerClosed]);
      expect(socket.listenerCount('message')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
      expect(socket.listenerCount('close')).toBe(0);
    }
    expect(sockets.clients.size).toBe(0);
  } finally {
    for (const session of sessions) session.close();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
