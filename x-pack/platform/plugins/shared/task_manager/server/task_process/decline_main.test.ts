/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { build } from 'esbuild';
import { REPO_ROOT } from '@kbn/repo-info';

describe('the task process of a task type that always declines', () => {
  let child: ChildProcess | undefined;
  afterEach(() => child?.kill());

  it('answers every run with a declined run, from a small bundle without Core', async () => {
    const outfile = join(REPO_ROOT, 'target', 'decline_main_test.js');
    await build({
      stdin: {
        contents: `import { runDecliningTaskProcess } from ${JSON.stringify(
          join(__dirname, 'decline_main')
        )};
runDecliningTaskProcess({ taskType: 'alerting:test', reason: 'needs a plugin' });`,
        resolveDir: REPO_ROOT,
        loader: 'ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      define: { __KBN_VERSION__: '"9.9.9"' },
    });

    child = spawn('node', [outfile], { env: { ...process.env, PORT: '0' } });
    const port = await new Promise<number>((resolve, reject) => {
      child!.stdout!.on('data', (chunk) => {
        const match = /READY (\d+)/.exec(String(chunk));
        if (match) resolve(Number(match[1]));
      });
      child!.on('error', reject);
    });

    const response = await undiciFetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskType: 'alerting:test',
        taskInstance: { id: '1', taskType: 'alerting:test', params: {}, state: {} },
        executionUuid: 'uuid',
      }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ kind: 'declined', reason: 'needs a plugin' });
  });
});
