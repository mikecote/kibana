/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { transformSync } from '@swc/core';
import { getNodeSwcConfig } from '@kbn/swc-config/node';
import { REPO_ROOT } from '@kbn/repo-info';
import { getRemoteManifestPaths } from '@kbn/repo-packages';
import { interpretRemoteManifest } from '@kbn/import-locator';
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

it.each(getRemoteManifestPaths(REPO_ROOT))(
  'loads $pluginId remote manifest after distributable transpilation with JS-only targets',
  ({ path: file }) => {
    const directory = mkdtempSync(join(tmpdir(), 'distributed-remote-manifest-'));
    try {
      const remote = interpretRemoteManifest(file);
      const modules = [
        ...(remote.taskTypes ?? []),
        ...Object.values(remote.capabilities ?? {}),
        ...Object.values(remote.contributions ?? {}).flat(),
      ];
      for (const { modulePath } of modules) {
        const destination = join(
          directory,
          relative(REPO_ROOT, modulePath).replace(/\.ts$/, '.js')
        );
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          'throw new Error("Manifest resolution must not execute implementations");'
        );
      }
      // Identical transformation/options to build_packages_task.ts; target stubs are JS-only.
      const { code } = transformSync(
        readFileSync(file, 'utf8'),
        getNodeSwcConfig(file, { production: true })
      );
      const compiled = join(directory, relative(REPO_ROOT, file).replace(/\.ts$/, '.js'));
      mkdirSync(dirname(compiled), { recursive: true });
      writeFileSync(compiled, code);
      const output = execFileSync(
        process.execPath,
        ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(compiled)}).remote))`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      expect(JSON.parse(output)).toEqual(expect.any(Object));
      expect(output).not.toContain('.ts"');
      expect(output).toContain('.js"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
