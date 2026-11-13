/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { REPO_ROOT } from '@kbn/repo-info';
import { getBundleOutputs, getStartupAnalysis, getStartupOutputs } from './build';

it('packages every reachable shared and deferred chunk for each task without including another entry', () => {
  const metafile = {
    outputs: {
      'first.mjs': {
        imports: [
          { path: 'shared.mjs', kind: 'import-statement' },
          { path: 'first_executor.mjs', kind: 'dynamic-import' },
        ],
      },
      'first.mjs.map': {},
      'second.mjs': { imports: [{ path: 'shared.mjs', kind: 'import-statement' }] },
      'shared.mjs': {
        imports: [
          { path: 'first.mjs', kind: 'dynamic-import' },
          { path: 'node:fs', external: true },
        ],
      },
      'shared.mjs.map': {},
      'first_executor.mjs': { imports: [] },
      'first_executor.mjs.map': {},
    },
  };
  expect(getBundleOutputs(metafile, join(REPO_ROOT, 'first.mjs'))).toEqual(
    [
      'first.mjs',
      'first.mjs.map',
      'shared.mjs',
      'shared.mjs.map',
      'first_executor.mjs',
      'first_executor.mjs.map',
    ].map((file) => join(REPO_ROOT, file))
  );
});

it('counts the generated bootstrap imports awaited before READY while keeping business imports deferred', () => {
  const metafile = {
    outputs: {
      'entry.mjs': {
        entryPoint: 'test__task.entry.ts',
        imports: [
          { path: 'bootstrap.mjs', kind: 'import-statement' },
          { path: 'core.mjs', kind: 'dynamic-import' },
          { path: 'task.mjs', kind: 'dynamic-import' },
        ],
      },
      'bootstrap.mjs': { imports: [{ path: 'instrumentation.mjs', kind: 'dynamic-import' }] },
      'instrumentation.mjs': {
        inputs: { 'x-pack/task_process/instrumentation.ts': { bytesInOutput: 100 } },
        imports: [{ path: 'context.mjs', kind: 'import-statement' }],
      },
      'context.mjs': { imports: [] },
      'core.mjs': { imports: [] },
      'task.mjs': { imports: [{ path: 'executor.mjs', kind: 'dynamic-import' }] },
      'executor.mjs': { imports: [] },
    },
  };
  expect(getStartupOutputs(metafile, join(REPO_ROOT, 'entry.mjs'))).toEqual(
    [
      'entry.mjs',
      'bootstrap.mjs',
      'core.mjs',
      'task.mjs',
      'instrumentation.mjs',
      'context.mjs',
    ].map((file) => join(REPO_ROOT, file))
  );
});

it('attributes only loaded startup inputs and identifies EUI import paths', () => {
  const metafile = {
    inputs: {
      'src/server/palette.ts': {
        imports: [{ path: 'node_modules/@elastic/eui/es/index.js', kind: 'import-statement' }],
      },
    },
    outputs: {
      'entry.mjs': {
        entryPoint: 'test__task.entry.ts',
        imports: [{ path: 'startup.mjs', kind: 'import-statement' }],
        inputs: {},
      },
      'startup.mjs': {
        imports: [{ path: 'deferred.mjs', kind: 'dynamic-import' }],
        inputs: {
          'src/server/palette.ts': { bytesInOutput: 100 },
          'node_modules/@elastic/eui/es/index.js': { bytesInOutput: 25 },
        },
      },
      'deferred.mjs': {
        imports: [],
        inputs: { 'node_modules/jsdom/lib/api.js': { bytesInOutput: 200 } },
      },
    },
  };
  expect(getStartupAnalysis(metafile, join(REPO_ROOT, 'entry.mjs'))).toEqual({
    packages: { workspace: 100, '@elastic/eui': 25 },
    euiImporters: ['src/server/palette.ts'],
  });
});
