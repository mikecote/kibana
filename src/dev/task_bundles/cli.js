/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const path = require('path');
const {
  OUT_DIR,
  getTaskBundleEntries,
  getContributionFiles,
  buildTaskBundles,
  writeManifest,
} = require('./build');

// node scripts/task_bundle [--name <bundle>]... [--out <dir>] [--manifest]
//   [--contribution-keys none|<key>[,<key>...]]
// Builds the task type files declared in `kibana.jsonc` (`plugin.taskTypes`) into one bundle each,
// in target/task_bundles, with a manifest of the task types each bundle serves.
// `--contribution-keys` restricts which `taskTypeContributions` keys are resolved to files
// (`--contribution-keys none` keeps none): every other key the task type or a loaded contribution asks
// for still exists in the built module, with zero files. Used to measure what a thin worker with fewer
// (or no) plugin contributions costs, without touching `kibana.jsonc` declarations.
const args = process.argv.slice(2);
const getArgs = (flag) =>
  args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
const getArg = (flag) => getArgs(flag)[0];

const main = async () => {
  const entries = getTaskBundleEntries();
  const names = getArgs('--name');
  const outDir = getArg('--out') ?? OUT_DIR;
  const contributionKeysArg = getArg('--contribution-keys');
  const getContributionFilesOverride =
    contributionKeysArg === undefined
      ? undefined
      : (() => {
          const allowed = new Set(
            contributionKeysArg === 'none'
              ? []
              : contributionKeysArg
                  .split(',')
                  .map((key) => key.trim())
                  .filter(Boolean)
          );
          return (key) => (allowed.has(key) ? getContributionFiles(key) : []);
        })();
  const selected = names.length
    ? entries.filter((e) => names.some((name) => e.name === name || e.name.endsWith(`__${name}`)))
    : entries;
  if (!selected.length) {
    console.error(
      `no task bundle ${names.length ? `named '${names}'` : 'declared'}; known: ${entries
        .map((e) => e.name)
        .join(', ')}`
    );
    process.exit(1);
  }
  const started = Date.now();
  const results = await buildTaskBundles({
    entries: selected,
    outDir,
    ...(getContributionFilesOverride ? { getContributionFilesOverride } : {}),
  });
  for (const result of results) {
    console.log(
      `${result.name}: ${(result.bytes / 1024).toFixed(0)} KB, ${
        Date.now() - started
      } ms batch -> ${path.relative(process.cwd(), result.outfile)}`
    );
  }
  // A partial build must not replace the manifest of a full one, unless it goes to its own directory.
  if (!names.length || args.includes('--manifest')) writeManifest(results, outDir);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
