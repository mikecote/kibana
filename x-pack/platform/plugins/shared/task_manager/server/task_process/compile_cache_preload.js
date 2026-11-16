/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Plain JS, loaded with `--require` before the entry's own module graph (including the CJS/ESM
// interop bridge the bundle's banner installs), so this is the first thing the process runs. A
// hit saves the parse and compile of every `.mjs` chunk the entry and its imports load; a miss
// costs nothing beyond checking the file is absent. `TASK_PROCESS_COMPILE_CACHE_DIR` is unset
// when the setting is off, for a remote worker, or for the development benchmark.
const dir = process.env.TASK_PROCESS_COMPILE_CACHE_DIR;
if (dir) {
  const nodeModule = require('node:module');
  if (typeof nodeModule.enableCompileCache === 'function') {
    nodeModule.enableCompileCache(dir);
    // A cache entry is written lazily; flush before the process exits (normal completion or the
    // parent's shutdown signal) so a short-lived one-task-per-fork process still benefits later
    // runs. `flushCompileCache` is sync and a no-op when nothing changed.
    const flush = () => nodeModule.flushCompileCache?.();
    process.once('exit', flush);
  }
}
