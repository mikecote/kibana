/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { spawn } = require('child_process');

/**
 * Starts a bundle in a fresh process with the flags task processes run with, waits for READY and
 * reports its RSS (as the process itself sees it) and the time to ready. No Elasticsearch needed:
 * the client connects lazily.
 */
const measureBundle = (file, { env = {}, timeoutMs = 60000 } = {}) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--max-semi-space-size=8', file], {
      env: {
        ...process.env,
        ES_URL: 'http://localhost:9200',
        ES_USERNAME: 'elastic',
        ES_PASSWORD: 'changeme',
        PORT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${file} was not ready in ${timeoutMs} ms: ${stderr.slice(0, 500)}`));
    }, timeoutMs);
    child.stdout.on('data', async (chunk) => {
      out += chunk;
      const ready = /^READY (\d+)$/m.exec(out);
      if (!ready) return;
      clearTimeout(timer);
      const readyMs = Date.now() - started;
      try {
        const health = await (await fetch(`http://127.0.0.1:${ready[1]}/health`)).json();
        child.kill('SIGTERM');
        resolve({ readyMs, rssMb: Math.round(health.rss / 1048576) });
      } catch (error) {
        child.kill('SIGKILL');
        reject(error);
      }
    });
    child.once(
      'exit',
      (code) => code && reject(new Error(`exited ${code}: ${stderr.slice(0, 500)}`))
    );
  });

/** Median of several fresh-process measurements. */
const measureBundleMedian = async (file, runs = 3) => {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await measureBundle(file));
  const median = (key) => results.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(runs / 2)];
  return { readyMs: median('readyMs'), rssMb: median('rssMb') };
};

module.exports = { measureBundle, measureBundleMedian };
