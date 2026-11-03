/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const fs = require('fs');
const { createRequire } = require('module');
const path = require('path');
const { build } = require('esbuild');
const { REPO_ROOT } = require('@kbn/repo-info');
const { getPackages } = require('@kbn/repo-packages');
const { findForbiddenInputs } = require('./forbidden_inputs');

const OUT_DIR = path.join(REPO_ROOT, 'target', 'task_bundles');
const RUNTIME_ENTRY = path.join(
  REPO_ROOT,
  'x-pack/platform/plugins/shared/task_manager/server/task_runtime/main'
);

/** Native modules stay out of the bundle and resolve from node_modules at run time. */
const EXTERNALS = ['re2'];

/** Every task type module declared in a plugin's `kibana.jsonc` (`plugin.taskTypes`). */
const getTaskBundleEntries = (packages = getPackages(REPO_ROOT)) =>
  packages
    .filter((pkg) => pkg.manifest.type === 'plugin' && pkg.manifest.plugin.taskTypes?.length)
    .flatMap((pkg) =>
      pkg.manifest.plugin.taskTypes.map((file) => ({
        pluginId: pkg.manifest.plugin.id,
        file: path.join(pkg.directory, file),
        name: `${pkg.manifest.plugin.id}__${path.basename(file).replace(/\.task\.[jt]s$/, '')}`,
      }))
    );

const peggyPlugin = {
  name: 'peggy',
  setup(b) {
    const peggy = require('peggy');
    b.onLoad({ filter: /\.peggy$/ }, (args) => ({
      contents: peggy.generate(fs.readFileSync(args.path, 'utf8'), {
        output: 'source',
        format: 'commonjs',
      }),
      loader: 'js',
    }));
  },
};

/**
 * Bundles a task type module together with the task host into one file that runs it:
 * `node <name>.js` serves `/health`, `/run` and `/cancel` for Task Manager.
 */
const buildTaskBundle = async ({ entry, outDir = OUT_DIR, kibanaVersion, write = true }) => {
  const version = kibanaVersion ?? require('@kbn/repo-info').kibanaPackageJson.version;
  const outfile = path.join(outDir, `${entry.name}.js`);
  const result = await build({
    stdin: {
      contents: [
        `import { runTaskProcess } from ${JSON.stringify(RUNTIME_ENTRY)};`,
        `import * as unit from ${JSON.stringify(entry.file)};`,
        `runTaskProcess(unit.taskType);`,
      ].join('\n'),
      resolveDir: REPO_ROOT,
      sourcefile: `${entry.name}.entry.ts`,
      loader: 'ts',
    },
    outfile,
    write,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    absWorkingDir: REPO_ROOT,
    tsconfig: path.join(REPO_ROOT, 'tsconfig.base.json'),
    metafile: true,
    logLevel: 'silent',
    logLimit: 0,
    minifyWhitespace: true,
    minifySyntax: true,
    keepNames: true,
    sourcemap: write ? 'linked' : false,
    sourcesContent: false,
    external: EXTERNALS,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': '__kbn_import_meta_url',
      __KBN_VERSION__: JSON.stringify(version),
    },
    banner: {
      js: '"use strict";var __kbn_import_meta_url=require("url").pathToFileURL(__filename).href;',
    },
    loader: {
      '.md': 'text',
      '.txt': 'text',
      '.html': 'text',
      '.css': 'empty',
      '.svg': 'empty',
      '.png': 'empty',
      '.node': 'empty',
    },
    plugins: [peggyPlugin],
  });

  const inputs = Object.keys(result.metafile.inputs);
  const output = Object.values(result.metafile.outputs)[0];
  const entries = [
    path.relative(REPO_ROOT, RUNTIME_ENTRY),
    path.relative(REPO_ROOT, entry.file).replace(/\.[jt]sx?$/, ''),
  ];
  const forbidden = findForbiddenInputs(result.metafile, entries);
  return {
    name: entry.name,
    outfile,
    bytes: write ? fs.statSync(outfile).size : output.bytes,
    inputs: inputs.length,
    forbidden,
    entry,
    entries,
    metafile: result.metafile,
  };
};

/**
 * The task types a unit file declares (`taskType` or `taskTypes`). Loads the file, which needs the
 * source transpiler or a built tree, so it runs where the bundles are built.
 */
const readTaskTypes = (file) => {
  const unit = createRequire(__filename)(file);
  return (unit.taskTypes ?? [unit.taskType]).map((t) => t.type);
};

/** Writes `manifest.json`: which task types each bundle serves, read by Kibana's supervisor. */
const writeManifest = (results, outDir = OUT_DIR) => {
  const manifest = {
    kibanaVersion: require('@kbn/repo-info').kibanaPackageJson.version,
    bundles: Object.fromEntries(
      results.map(({ entry, name, bytes }) => [
        name,
        { file: `${name}.js`, taskTypes: readTaskTypes(entry.file), bytes },
      ])
    ),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

module.exports = { OUT_DIR, getTaskBundleEntries, buildTaskBundle, writeManifest };
