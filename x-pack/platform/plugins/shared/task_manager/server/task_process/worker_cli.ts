/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { LoggingSystem } from '@kbn/core-logging-server-internal';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import { startTaskProcessWorker } from './worker';

const readInteger = (name: string, defaultValue: number, min: number, max: number): number => {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const port = readInteger('PORT', 5602, 0, 65535);
  const maxConcurrentProcesses = readInteger('TASK_PROCESS_MAX_CONCURRENT', 4, 1, 1024);
  const logging = new LoggingSystem();
  await logging.upgrade();
  const { server } = startTaskProcessWorker({
    settings: {
      bundle_dir: process.env.TASK_PROCESS_BUNDLE_DIR ?? join(REPO_ROOT, 'target/task_bundles'),
      kibanaVersion: kibanaPackageJson.version,
      maxConcurrentProcesses,
      reuse:
        process.env.TASK_PROCESS_REUSE === 'true'
          ? { idleTimeoutMs: 30_000, maxAgeMs: 300_000, maxRuns: 100, maxIdleProcesses: 4 }
          : undefined,
    },
    logger: logging.get('task-worker'),
    authToken: process.env.TASK_PROCESS_TOKEN ?? '',
    port,
    host: process.env.HOST ?? '127.0.0.1',
  });
  server.once('listening', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      logging
        .get('task-worker')
        .info(`Task worker listening on ${address.address}:${address.port}`);
    }
  });
  server.on('error', (error) => {
    logging.get('task-worker').error(error);
    process.exitCode = 1;
  });
};

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
