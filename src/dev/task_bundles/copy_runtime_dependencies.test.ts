/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTaskRuntimeDependencies } from './copy_runtime_dependencies';

it('runs the actual native APM agent from a moved artifact without repository dependencies', () => {
  const artifact = mkdtempSync(join(tmpdir(), 'task-native-sdk-'));
  const workingDirectory = mkdtempSync(join(tmpdir(), 'task-native-sdk-cwd-'));
  try {
    const runtime = copyTaskRuntimeDependencies(artifact);
    expect(runtime.bytes).toBeGreaterThan(0);
    expect(runtime.files).toContain('node_modules/elastic-apm-node/package.json');
    expect(runtime.files.some((file) => file.endsWith('.node'))).toBe(false);
    const probe = join(artifact, 'probe.cjs');
    writeFileSync(
      probe,
      `
      const agent = require('elastic-apm-node');
      agent.start({ serviceName: 'native-artifact-proof', serviceVersion: '1.0.0',
        active: true, contextPropagationOnly: true, metricsInterval: '0s',
        centralConfig: false, cloudProvider: 'none', captureExceptions: false, logLevel: 'off' });
      const transaction = agent.startTransaction('portable', 'task-run', {
        childOf: '00-11111111111111111111111111111111-2222222222222222-01'
      });
      if (!transaction) throw new Error('Native APM did not create a transaction');
      transaction.end();
      process.stdout.write(JSON.stringify({ started: agent.isStarted(), traceparent: transaction.traceparent }));
      agent.destroy().catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });
    `
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(ELASTIC_APM_|OTEL_)/.test(key))
    );
    const result = spawnSync(process.execPath, [probe], {
      cwd: workingDirectory,
      env: { ...environment, NODE_PATH: '', NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      started: true,
      traceparent: expect.stringMatching(/^00-11111111111111111111111111111111-/),
    });
  } finally {
    rmSync(artifact, { recursive: true, force: true });
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

it('refuses to replace a node_modules directory it does not own', () => {
  const artifact = mkdtempSync(join(tmpdir(), 'task-native-sdk-ownership-'));
  try {
    const dependencies = join(artifact, 'node_modules');
    mkdirSync(dependencies);
    const preserved = join(dependencies, 'preserved.txt');
    writeFileSync(preserved, 'original');
    expect(() => copyTaskRuntimeDependencies(artifact)).toThrow('not owned by task bundles');
    expect(existsSync(preserved)).toBe(true);
    expect(readFileSync(preserved, 'utf8')).toBe('original');
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
});
