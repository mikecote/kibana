/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const v8 = require('v8');

// Loaded only by the development benchmark, never by the supervisor or a distributable entry.
if (process.send) {
  const send = process.send.bind(process);
  const snapshot = (phase) =>
    send({
      kind: 'task-bundle-memory',
      phase,
      usage: process.memoryUsage(),
      peakRss: process.resourceUsage().maxRSS * 1024,
      spaces: v8.getHeapSpaceStatistics(),
    });
  process.send = (message, ...args) => {
    if (message?.kind === 'ready') snapshot('ready');
    return send(message, ...args);
  };
  process.on('message', (message) => {
    if (message?.kind === 'task-bundle-memory') snapshot(message.phase);
  });
  setInterval(() => send({ kind: 'task-bundle-rss', rss: process.memoryUsage.rss() }), 50).unref();
}
