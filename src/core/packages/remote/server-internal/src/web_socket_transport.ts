/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { RpcTransport } from 'capnweb';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { IpcTraffic } from './ipc_transport';

/** Carries the same string RPC frames as fork IPC, with WebSocket frame-byte accounting. */
export class WebSocketTransport implements RpcTransport {
  readonly encodingLevel = 'string' as const;
  private readonly traffic = { calls: 0, bytes: 0, messages: 0 };
  private readonly queue: string[] = [];
  private pending?: { resolve: (message: string) => void; reject: (error: Error) => void };
  private error?: Error;

  constructor(private readonly socket: WebSocket, private readonly side: 'client' | 'server') {
    socket.on('message', this.onMessage);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  getTraffic(): IpcTraffic {
    return { ...this.traffic };
  }

  private record(payload: string, masked: boolean): void {
    const bytes = Buffer.byteLength(payload);
    if (payload.startsWith('["push",')) this.traffic.calls++;
    // ws sends each RPC string as one uncompressed frame. Count its length field and client mask.
    this.traffic.bytes += bytes + (bytes < 126 ? 2 : bytes <= 65535 ? 4 : 10) + (masked ? 4 : 0);
    this.traffic.messages++;
  }

  private readonly onMessage = (data: RawData, binary: boolean): void => {
    if (binary || Array.isArray(data)) {
      this.abort(new Error('Remote WebSocket session requires string RPC frames'));
      return;
    }
    const payload = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Buffer.from(data).toString('utf8');
    this.record(payload, this.side === 'server');
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = undefined;
      resolve(payload);
    } else this.queue.push(payload);
  };

  private readonly onError = (error: Error): void => this.abort(error);
  private readonly onClose = (): void => this.abort(new Error('Remote WebSocket disconnected'));

  send(payload: string): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    this.record(payload, this.side === 'client');
    return new Promise((resolve, reject) => {
      this.socket.send(payload, { compress: false }, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  receive(): Promise<string> {
    if (this.error) return Promise.reject(this.error);
    const message = this.queue.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  abort(reason: unknown): void {
    if (this.error) return;
    this.error = reason instanceof Error ? reason : new Error(String(reason));
    this.queue.length = 0;
    this.pending?.reject(this.error);
    this.pending = undefined;
    this.socket.off('message', this.onMessage);
    this.socket.off('close', this.onClose);
    if (this.socket.readyState === this.socket.CLOSED) {
      this.socket.off('error', this.onError);
    } else {
      this.socket.once('close', () => this.socket.off('error', this.onError));
      this.socket.close();
    }
  }
}
