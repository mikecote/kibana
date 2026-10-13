/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { MessageChannel } from 'node:worker_threads';

/**
 * Resolves in its own event loop turn, from a native callback.
 *
 * A terminated run drops every continuation queued in the same microtask checkpoint, so a run is
 * started from a checkpoint nothing else shares. The turn has to be native, not `setImmediate` or
 * a timer: those drain microtasks from JavaScript (`runNextTicks` under `processImmediate`), a
 * stack the termination gate refuses, whereas a continuation resumed from a native callback has
 * no Node dispatcher frame on its stack.
 */
const channel = new MessageChannel();
const pending: Array<() => void> = [];
channel.port1.on('message', () => {
  pending.shift()?.();
  // Referenced only while a turn is pending: an idle channel must not keep the process alive.
  if (pending.length === 0) channel.port1.unref();
});
channel.port1.unref();

export const nextNativeTurn = (): Promise<void> =>
  new Promise((resolve) => {
    pending.push(resolve);
    channel.port1.ref();
    channel.port2.postMessage(null);
  });
