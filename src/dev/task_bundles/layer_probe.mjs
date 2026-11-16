/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

// Forked by `bench.js --layers`: imports the chunk files named in `LAYER_PROBE_FILES` (a JSON array
// of absolute paths, in the order the generated entry's `Promise.all` awaits them) and reports the
// time and resident memory of doing only that, with no Core and no Elasticsearch. This isolates what
// module loading itself costs, as a lower bound a real worker's startup cannot beat.
import v8 from 'node:v8';

const files = JSON.parse(process.env.LAYER_PROBE_FILES || '[]');
const started = process.hrtime.bigint();
const results = await Promise.allSettled(files.map((file) => import(file)));
const importMs = Number(process.hrtime.bigint() - started) / 1e6;
const failed = results
  .filter((result) => result.status === 'rejected')
  .map((result) => String(result.reason).slice(0, 300));

if (typeof global.gc === 'function') {
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
}

const usage = process.memoryUsage();
const spaces = Object.fromEntries(
  v8.getHeapSpaceStatistics().map((space) => [space.space_name, space.space_used_size])
);

process.send({
  kind: 'layer-probe-result',
  modules: files.length,
  failed,
  importMs: Math.round(importMs),
  rss: usage.rss,
  heapUsed: usage.heapUsed,
  heapTotal: usage.heapTotal,
  external: usage.external,
  spaces,
});
process.exit(failed.length ? 1 : 0);
