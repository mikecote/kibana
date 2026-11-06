/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const path = require('path');
const { REPO_ROOT } = require('@kbn/repo-info');
const { getStartupOutputs } = require('./build');

describe('getStartupOutputs', () => {
  it('follows static chunks once, including cycles, and excludes deferred and external imports', () => {
    const metafile = {
      outputs: {
        'entry.mjs': {
          imports: [
            { path: 'common.mjs', kind: 'import-statement' },
            { path: 'executor.mjs', kind: 'dynamic-import' },
            { path: 'node:fs', kind: 'import-statement', external: true },
          ],
        },
        'common.mjs': { imports: [{ path: 'entry.mjs', kind: 'import-statement' }] },
        'executor.mjs': { imports: [{ path: 'driver.mjs', kind: 'import-statement' }] },
        'driver.mjs': { imports: [] },
      },
    };
    expect(getStartupOutputs(metafile, path.join(REPO_ROOT, 'entry.mjs'))).toEqual([
      path.join(REPO_ROOT, 'entry.mjs'),
      path.join(REPO_ROOT, 'common.mjs'),
    ]);
  });
});
