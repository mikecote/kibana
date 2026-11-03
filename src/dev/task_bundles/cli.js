/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const path = require('path');
const { OUT_DIR, getTaskBundleEntries, buildTaskBundle } = require('./build');

// node scripts/task_bundle [--name <bundle>] [--all] [--size] [--out <dir>]
// Builds task bundles into target/task_bundles and reports their size and any forbidden input.
const args = process.argv.slice(2);
const getArg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

const main = async () => {
  const entries = getTaskBundleEntries();
  const name = getArg('--name');
  const selected = name
    ? entries.filter((e) => e.name === name || e.name.endsWith(`__${name}`))
    : entries;
  if (!selected.length) {
    console.error(
      `no task bundle ${name ? `named '${name}'` : 'declared'}; known: ${entries
        .map((e) => e.name)
        .join(', ')}`
    );
    process.exit(1);
  }
  let failed = false;
  for (const entry of selected) {
    const started = Date.now();
    const result = await buildTaskBundle({ entry, outDir: getArg('--out') ?? OUT_DIR });
    console.log(
      `${result.name}: ${(result.bytes / 1024).toFixed(0)} KB, ${result.inputs} inputs, ${
        Date.now() - started
      } ms -> ${path.relative(process.cwd(), result.outfile)}`
    );
    if (args.includes('--size')) {
      const byPackage = new Map();
      for (const [file, { bytes }] of Object.entries(result.metafile.inputs)) {
        const key = file.includes('node_modules/')
          ? 'node_modules/' +
            file
              .split('node_modules/')
              .pop()
              .split('/')
              .slice(0, file.includes('node_modules/@') ? 2 : 1)
              .join('/')
          : file.split('/').slice(0, 5).join('/');
        byPackage.set(key, (byPackage.get(key) ?? 0) + bytes);
      }
      [...byPackage]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .forEach(([key, bytes]) =>
          console.log(`  ${String(Math.round(bytes / 1024)).padStart(6)} KB  ${key}`)
        );
    }
    const why = getArg('--why');
    if (why) {
      const { shortestChain } = require('./forbidden_inputs');
      const chain = shortestChain(result.metafile, result.entries, why);
      console.log(
        chain
          ? chain.map((c, i) => `  ${'  '.repeat(i)}${c}`).join('\n')
          : `  '${why}' is not in the bundle`
      );
    }
    for (const hit of result.forbidden) {
      failed = true;
      console.error(
        `  FORBIDDEN ${hit.id}: ${hit.reason}\n${hit.chain
          .map((c, i) => `    ${'  '.repeat(i)}${c}`)
          .join('\n')}`
      );
    }
  }
  if (failed) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
