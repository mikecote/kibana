/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { staticRemoteManifestsPlugin } from './build';

it('bundles remote manifests as resolved data without executing their referenced modules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'static-remote-manifest-'));
  try {
    mkdirSync(join(directory, 'server/remote'), { recursive: true });
    const task = join(directory, 'server/task.ts');
    const entry = join(directory, 'server/remote/index.ts');
    const outfile = join(directory, 'manifest.cjs');
    writeFileSync(task, 'throw new Error("must not execute");');
    writeFileSync(
      entry,
      `export const remote = {
      taskTypes: [{ modulePath: require.resolve('../task.ts'), exportName: 'taskType' }]
    } as const;`
    );
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [staticRemoteManifestsPlugin],
    });
    expect(
      execFileSync(
        process.execPath,
        [
          '-e',
          `process.stdout.write(require(${JSON.stringify(
            outfile
          )}).remote.taskTypes[0].modulePath)`,
        ],
        { encoding: 'utf8' }
      )
    ).toEqual(realpathSync(task));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
