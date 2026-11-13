/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Package } from './package';
import { getRemoteManifestPaths } from './get_packages';

it('discovers only plugin convention entries without reading or executing them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-manifest-paths-'));
  try {
    const plugin = new Package(
      directory,
      directory,
      {
        type: 'plugin',
        id: '@kbn/test-plugin',
        owner: ['test'],
        plugin: { id: 'testPlugin', server: true, browser: false },
      },
      undefined
    );
    const library = new Package(
      directory,
      directory,
      {
        type: 'shared-server',
        id: '@kbn/test-library',
        owner: ['test'],
      },
      undefined
    );
    expect(getRemoteManifestPaths(directory, [plugin, library])).toEqual([]);
    mkdirSync(join(directory, 'server/remote'), { recursive: true });
    const path = join(directory, 'server/remote/index.ts');
    writeFileSync(path, 'throw new Error("discovery must not execute or parse this");');
    expect(getRemoteManifestPaths(directory, [plugin, library])).toEqual([
      { directory, pluginId: 'testPlugin', path },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
