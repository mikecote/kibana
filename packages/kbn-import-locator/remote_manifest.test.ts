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
import { interpretRemoteManifest } from './remote_manifest';

describe('interpretRemoteManifest', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'remote-manifest-'));
    mkdirSync(join(directory, 'server/remote'), { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = (contents: string) =>
    writeFileSync(join(directory, 'server/remote/index.ts'), contents);

  it('resolves modules without executing their code', () => {
    writeFileSync(join(directory, 'server/task.ts'), 'throw new Error("must not execute");');
    manifest(`export const remote = {
      taskTypes: [{ modulePath: require.resolve('../task.ts'), exportName: 'nativeTask' }],
      contributions: { steps: [{ modulePath: require.resolve('../task.ts'), exportName: 'steps' }] },
      capabilities: { Work: { token: 'test.Work', placement: 'executor', scope: 'run', needs: [],
        modulePath: require.resolve('../task.ts'), exportName: 'Work' } }
    } as const;`);
    const declaration = { modulePath: join(directory, 'server/task.ts'), exportName: 'nativeTask' };
    expect(interpretRemoteManifest(join(directory, 'server/remote/index.ts'))).toEqual({
      taskTypes: [declaration],
      contributions: { steps: [{ ...declaration, exportName: 'steps' }] },
      capabilities: {
        Work: {
          token: 'test.Work',
          placement: 'executor',
          scope: 'run',
          needs: [],
          ...declaration,
          exportName: 'Work',
        },
      },
    });
  });

  it.each([
    `import './plugin'; export const remote = {};`,
    `export const remote = require('./plugin');`,
    `export const remote = { taskTypes: makeTasks() };`,
    `export const remote = { ...other };`,
    `export const remote = { get taskTypes() { throw new Error('executed'); } };`,
    `export const remote = {}; process.exit(1);`,
    `export let remote = {};`,
  ])('rejects executable declarations: %s', (source) => {
    manifest(source);
    expect(() => interpretRemoteManifest(join(directory, 'server/remote/index.ts'))).toThrow(
      'Invalid static remote manifest'
    );
  });
});
