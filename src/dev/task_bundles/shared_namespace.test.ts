/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { REPO_ROOT } from '@kbn/repo-info';
import { TASK_BUNDLE_OPTIMIZATION } from './build';

it('executes namespace getters shared with a directly imported task entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-shared-namespace-'));
  try {
    const fields = join(REPO_ROOT, 'x-pack/platform/packages/shared/kbn-apm-types');
    writeFileSync(
      join(directory, 'direct.ts'),
      `import { ID } from ${JSON.stringify(join(fields, 'src/es_fields/apm'))}; console.log(ID);`
    );
    writeFileSync(
      join(directory, 'namespace.ts'),
      `import * as fields from ${JSON.stringify(
        join(fields, 'es_fields')
      )}; console.log(Object.values(fields).includes('_id'));`
    );
    await build({
      entryPoints: [join(directory, 'direct.ts'), join(directory, 'namespace.ts')],
      outdir: join(directory, 'out'),
      outExtension: { '.js': '.mjs' },
      splitting: true,
      format: 'esm',
      bundle: true,
      platform: 'node',
      ...TASK_BUNDLE_OPTIMIZATION,
    });
    expect(
      execFileSync(process.execPath, [join(directory, 'out/namespace.mjs')], { encoding: 'utf8' })
    ).toBe('true\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
