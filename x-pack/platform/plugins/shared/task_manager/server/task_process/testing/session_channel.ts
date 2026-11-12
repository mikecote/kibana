/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EventEmitter } from 'node:events';

export class SessionChannel extends EventEmitter {
  peer?: SessionChannel;

  send(message: object, callback: (error: Error | null) => void): boolean {
    queueMicrotask(() => this.peer?.emit('message', JSON.parse(JSON.stringify(message))));
    callback(null);
    return true;
  }
}

export const sessionChannelPair = (): [SessionChannel, SessionChannel] => {
  const first = new SessionChannel();
  const second = new SessionChannel();
  first.peer = second;
  second.peer = first;
  return [first, second];
};
