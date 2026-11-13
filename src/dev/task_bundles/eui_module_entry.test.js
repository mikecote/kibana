/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { build } = require('esbuild');
const { euiModulePlugin, ecsModulePlugin, TASK_BUNDLE_OPTIMIZATION } = require('./build');

it('keeps palette imports out of the EUI CommonJS UI bundle', async () => {
  const result = await build({
    stdin: {
      contents: `import { euiPaletteColorBlind } from '@elastic/eui';
        console.log(euiPaletteColorBlind({ rotations: 1 }));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    ...TASK_BUNDLE_OPTIMIZATION,
    plugins: [euiModulePlugin],
  });
  const inputs = Object.keys(
    result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs
  );
  expect(inputs).toContain('node_modules/@elastic/eui/es/index.js');
  expect(inputs).not.toContain('node_modules/@elastic/eui/lib/index.js');
  expect(result.outputFiles[0].contents.length).toBeLessThan(2 * 1024 * 1024);
});

it('keeps the ECS field schema out of JSON logging imports', async () => {
  const result = await build({
    stdin: {
      contents: `import { EcsVersion } from '@elastic/ecs'; console.log(EcsVersion);`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    ...TASK_BUNDLE_OPTIMIZATION,
    plugins: [ecsModulePlugin],
  });
  const inputs = Object.keys(
    result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs
  );
  expect(inputs).not.toContain('node_modules/@elastic/ecs/build/commonjs/ecs_flat.js');
  expect(result.outputFiles[0].contents.length).toBeLessThan(10 * 1024);
});
