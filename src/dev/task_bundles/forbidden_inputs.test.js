/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { findForbiddenInputs, shortestChain } = require('./forbidden_inputs');

const imports = (...paths) => paths.map((path) => ({ path, kind: 'import-statement' }));
const metafile = {
  inputs: {
    'plugin/server/task_types/a.task.ts': { imports: imports('plugin/server/lib/runner.ts') },
    'plugin/server/lib/runner.ts': {
      imports: imports('x-pack/platform/plugins/shared/task_manager/server/index.ts'),
    },
    'x-pack/platform/plugins/shared/task_manager/server/index.ts': {
      imports: imports('src/core/packages/core/server/index.ts', 'node_modules/lodash/lodash.js'),
    },
    'src/core/packages/core/server/index.ts': { imports: [] },
    'node_modules/lodash/lodash.js': { imports: [] },
  },
};

describe('findForbiddenInputs', () => {
  it('reports each forbidden input with the import chain that reaches it', () => {
    const hits = findForbiddenInputs(metafile, ['plugin/server/task_types/a.task']);
    expect(hits.map((hit) => hit.id).sort()).toEqual([
      '@kbn/core/server',
      '@kbn/task-manager-plugin/server (barrel)',
    ]);
    expect(hits.find((hit) => hit.id === '@kbn/core/server').chain).toEqual([
      'plugin/server/task_types/a.task.ts',
      'plugin/server/lib/runner.ts',
      'x-pack/platform/plugins/shared/task_manager/server/index.ts',
      'src/core/packages/core/server/index.ts',
    ]);
  });

  it('reports nothing when the closure is clean', () => {
    const clean = { inputs: { 'a.ts': { imports: imports('node_modules/lodash/lodash.js') } } };
    expect(findForbiddenInputs(clean, ['a'])).toEqual([]);
  });

  it('can be allowed per input id', () => {
    const hits = findForbiddenInputs(
      metafile,
      ['plugin/server/task_types/a.task'],
      ['@kbn/core/server']
    );
    expect(hits.map((hit) => hit.id)).toEqual(['@kbn/task-manager-plugin/server (barrel)']);
  });
});

describe('shortestChain', () => {
  it('finds the shortest chain to an input and undefined when it is absent', () => {
    expect(shortestChain(metafile, ['plugin/server/task_types/a.task'], 'lodash.js')).toHaveLength(
      4
    );
    expect(shortestChain(metafile, ['plugin/server/task_types/a.task'], 'react')).toBeUndefined();
  });
});
