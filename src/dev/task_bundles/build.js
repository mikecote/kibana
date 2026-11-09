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
const { escapeNonLatin1 } = require('./escape_non_latin1');
const { copyTaskRuntimeDependencies } = require('./copy_runtime_dependencies');

const OUT_DIR = path.join(REPO_ROOT, 'target', 'task_bundles');
const RUNTIME_ENTRY = path.join(
  REPO_ROOT,
  'x-pack/platform/plugins/shared/task_manager/server/task_process/main'
);

/** Loads a task type file using the registered transpiler. */
const loadTaskType = (file) => createRequire(__filename)(file).taskType;

/**
 * Native modules stay out of the bundle and resolve from node_modules at run time. `canvas` is the
 * optional native dependency of jsdom, which jsdom loads inside a try/catch.
 */
const EXTERNALS = ['re2', 'canvas'];

/**
 * The files plugins contribute under a key (`plugin.taskTypeContributions` in `kibana.jsonc`), such as
 * `alerting-rule-run` for what every rule run needs. Each file exports `contribution`.
 */
const getContributionFiles = (key, packages = getPackages(REPO_ROOT)) =>
  packages
    .filter((pkg) => pkg.manifest.type === 'plugin')
    .flatMap((pkg) =>
      (pkg.manifest.plugin.taskTypeContributions?.[key] ?? []).map((file) =>
        path.resolve(REPO_ROOT, pkg.directory, file)
      )
    )
    .sort();

/** Resolves contribution keys added by native runtimes until the declaration graph is complete. */
const resolveTaskContributions = (
  taskType,
  additionalContributions = {},
  getFiles = getContributionFiles,
  loadContribution = (file) => createRequire(__filename)(file).contribution
) => {
  const filesByKey = {};
  const contributions = {};
  const keys = new Set(taskType.contributions?.keys ?? []);
  while ([...keys].some((key) => !(key in filesByKey))) {
    for (const key of keys) {
      if (key in filesByKey) continue;
      const files = [...new Set([...getFiles(key), ...(additionalContributions[key] ?? [])])];
      filesByKey[key] = files;
      contributions[key] = files.map((file) => {
        const contribution = loadContribution(file);
        if (!contribution) throw new Error(`Task contribution ${file} has no contribution export`);
        return contribution;
      });
    }
    const applied = taskType.contributions?.apply?.(contributions) ?? taskType;
    for (const key of applied.contributions?.keys ?? []) keys.add(key);
  }
  return filesByKey;
};

/** Collects the flag defaults of the module and every contributed native SDK. */
const collectTaskFeatureFlags = (taskType, contributions) =>
  Object.assign(
    {},
    taskType.featureFlags,
    ...contributions.map((item) => item.declares?.featureFlags)
  );

/** Every task type file declared in a plugin's `kibana.jsonc` (`plugin.taskTypes`). */
const getTaskBundleEntries = (packages = getPackages(REPO_ROOT)) =>
  packages
    .filter((pkg) => pkg.manifest.type === 'plugin' && pkg.manifest.plugin.taskTypes?.length)
    .flatMap((pkg) =>
      pkg.manifest.plugin.taskTypes.map((file) => ({
        pluginId: pkg.manifest.plugin.id,
        file: path.resolve(REPO_ROOT, pkg.directory, file),
        name: `${pkg.manifest.plugin.id}__${path.basename(file).replace(/\.task\.[jt]s$/, '')}`,
      }))
    );

/**
 * `@kbn/repo-info` finds the Kibana directory above the file that loads it, so a bundle copied
 * elsewhere, such as into a container, would not start. Only `@kbn/utils` uses it, for the
 * default config and data paths a task process does not read, so the bundle gets a fixed answer.
 */
const repoInfoPlugin = (version) => ({
  name: 'repo-info',
  setup(b) {
    b.onResolve({ filter: /^@kbn\/repo-info$/ }, () => ({
      path: 'repo-info',
      namespace: 'kbn-task-bundle',
    }));
    b.onLoad({ filter: /.*/, namespace: 'kbn-task-bundle' }, () => ({
      contents: `
        const path = require('path');
        const pkg = { version: ${JSON.stringify(version)}, build: {} };
        module.exports = {
          REPO_ROOT: process.cwd(),
          PKG_JSON: pkg,
          kibanaPackageJson: pkg,
          isKibanaDistributable: () => true,
          UPSTREAM_BRANCH: undefined,
          fromRoot: (...paths) => path.resolve(process.cwd(), ...paths),
        };`,
      loader: 'js',
    }));
  },
});

/**
 * Treats every workspace source file (not `node_modules`) as free of import-time side effects, as
 * Kibana's modules are. Then a barrel such as `@kbn/task-manager-plugin/server` costs only what is
 * used from it: without this, importing one constant from it pulls in the plugin class and
 * everything the plugin imports.
 */
/**
 * Core's rendering service imports the UI bundle locations at load, and they need built assets and
 * the repository on disk. A task process renders nothing.
 */
const uiSharedDepsStubPlugin = {
  name: 'ui-shared-deps-stub',
  setup(b) {
    b.onResolve({ filter: /^@kbn\/ui-shared-deps-(npm|src)$/ }, (args) => ({
      path: args.path,
      namespace: 'kbn-task-bundle-ui-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'kbn-task-bundle-ui-stub' }, () => ({
      contents: `module.exports = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : 'stub-' + String(key) });`,
      loader: 'js',
    }));
  },
};

/** The native APM agent loads instrumentation files relative to its installed package. */
const nativeApmAgentPlugin = {
  name: 'native-apm-agent',
  setup(b) {
    b.onResolve({ filter: /^elastic-apm-node$/ }, (args) =>
      args.namespace === 'task-process-native-apm'
        ? { path: args.path, external: true }
        : { path: args.path, namespace: 'task-process-native-apm' }
    );
    b.onLoad({ filter: /.*/, namespace: 'task-process-native-apm' }, () => ({
      contents: `module.exports = require('elastic-apm-node');`,
      loader: 'js',
    }));
  },
};

/** Imports kept for their side effects, which the pure workspace plugin would otherwise drop. */
const SIDE_EFFECT_FILES = /hapi_request_refs|[\\/]kbn-security-hardening[\\/]prototype\.[jt]s$/;

const pureWorkspacePlugin = {
  name: 'pure-workspace',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skipPure || args.kind === 'entry-point') return undefined;
      const resolved = await b.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        namespace: args.namespace,
        resolveDir: args.resolveDir,
        with: args.with,
        pluginData: { skipPure: true },
      });
      if (resolved.errors.length || resolved.external || resolved.namespace !== 'file') {
        return resolved.errors.length ? undefined : resolved;
      }
      return resolved.path.includes(`${path.sep}node_modules${path.sep}`) ||
        SIDE_EFFECT_FILES.test(resolved.path)
        ? resolved
        : { ...resolved, sideEffects: false };
    });
  },
};

const peggyPlugin = {
  name: 'peggy',
  setup(b) {
    // The grammar's own config (`<grammar>.config.json`, such as the KQL grammar's extra start rule)
    // is part of how it is generated, as it is for every other bundler of Kibana.
    const { getJsSourceSync } = require('@kbn/peggy');
    b.onLoad({ filter: /\.peggy$/ }, (args) => ({
      contents: getJsSourceSync({
        path: args.path,
        content: fs.readFileSync(args.path, 'utf8'),
        format: 'commonjs',
      }).source,
      loader: 'js',
    }));
  },
};

/** Returns static startup imports and the generated entry's imports awaited before readiness. */
const getStartupOutputs = (metafile, outfile) => {
  const outputs = new Map(
    Object.entries(metafile.outputs).map(([file, output]) => [
      path.resolve(REPO_ROOT, file),
      output,
    ])
  );
  const entryFile = path.resolve(outfile);
  const taskEntry = outputs.get(entryFile)?.entryPoint?.endsWith('.entry.ts') === true;
  const loaded = new Set();
  const visit = (file) => {
    if (loaded.has(file)) return;
    const output = outputs.get(file);
    if (!output) return;
    loaded.add(file);
    for (const dependency of output.imports) {
      if (dependency.external) continue;
      if (dependency.kind === 'dynamic-import' && !(taskEntry && file === entryFile)) continue;
      visit(path.resolve(REPO_ROOT, dependency.path));
    }
  };
  visit(entryFile);
  if (taskEntry) {
    for (const [file, output] of outputs) {
      if (
        Object.keys(output.inputs ?? {}).some((input) =>
          input.endsWith('/task_process/instrumentation.ts')
        )
      )
        visit(file);
    }
  }
  return [...loaded];
};

/** Lists the complete reachable code and source maps belonging to one native task entry. */
const getBundleOutputs = (metafile, outfile) => {
  const outputs = new Map(
    Object.entries(metafile.outputs).map(([file, metadata]) => [
      path.resolve(REPO_ROOT, file),
      metadata,
    ])
  );
  const files = new Set();
  const visit = (file) => {
    if (files.has(file) || !outputs.has(file)) return;
    files.add(file);
    if (outputs.has(`${file}.map`)) files.add(`${file}.map`);
    for (const dependency of outputs.get(file).imports ?? []) {
      if (!dependency.external) visit(path.resolve(REPO_ROOT, dependency.path));
    }
  };
  visit(path.resolve(outfile));
  return [...files];
};

// Syntax minification drops cross-entry imports backing namespace getters in the pinned esbuild.
const TASK_BUNDLE_OPTIMIZATION = {
  minifyWhitespace: true,
  minifySyntax: false,
  keepNames: true,
};

/** Builds native task entries in one graph, sharing their common runtime chunks. */
const buildTaskBundles = async ({
  entries,
  outDir = OUT_DIR,
  kibanaVersion,
  sourcemap = true,
  metafile = false,
  additionalContributions = {},
}) => {
  const version = kibanaVersion ?? require('@kbn/repo-info').kibanaPackageJson.version;
  const runtime = copyTaskRuntimeDependencies(outDir);
  const prepared = entries.map((entry) => {
    const loaded = loadTaskType(entry.file);
    if (!loaded) throw new Error(`Task module ${entry.file} has no taskType export`);
    // What the module says it takes from other plugins: every plugin's file under each key.
    const declarations = new Map();
    const contributions = resolveTaskContributions(
      loaded,
      additionalContributions,
      getContributionFiles,
      (file) => {
        const contribution = createRequire(__filename)(file).contribution;
        declarations.set(file, contribution);
        return contribution;
      }
    );
    const featureFlags = collectTaskFeatureFlags(loaded, [...declarations.values()]);
    const contributionImports = Object.values(contributions).flat();
    return {
      entry,
      featureFlags,
      contents: [
        `import { bootstrapTaskProcess } from ${JSON.stringify(
          path.join(path.dirname(RUNTIME_ENTRY), 'bootstrap')
        )};`,
        `const initialization = await bootstrapTaskProcess();`,
        `const [runtime, taskModule, ${contributionImports
          .map((_, i) => `contributionModule${i}`)
          .join(', ')}] = await Promise.all([`,
        `  import(${JSON.stringify(RUNTIME_ENTRY)}),`,
        `  import(${JSON.stringify(entry.file)}),`,
        ...contributionImports.map((file) => `  import(${JSON.stringify(file)}),`),
        `]);`,
        `runtime.runTaskProcess(taskModule.taskType, { ...initialization, contributions: {`,
        ...Object.entries(contributions).map(([key, files]) => {
          const names = files.map(
            (file) => `contributionModule${contributionImports.indexOf(file)}.contribution`
          );
          return `  ${JSON.stringify(key)}: [${names.join(', ')}],`;
        }),
        `} });`,
      ].join('\n'),
    };
  });
  const sources = new Map(prepared.map((item) => [`${item.entry.name}.entry.ts`, item.contents]));
  const taskEntriesPlugin = {
    name: 'native-task-entries',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^task-entry:/ }, ({ path: file }) => ({
        path: file.slice('task-entry:'.length),
        namespace: 'task-entry',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'task-entry' }, ({ path: file }) => ({
        contents: sources.get(file),
        resolveDir: REPO_ROOT,
        loader: 'ts',
      }));
    },
  };
  const result = await build({
    entryPoints: prepared.map(({ entry }) => ({
      in: `task-entry:${entry.name}.entry.ts`,
      out: entry.name,
    })),
    outdir: outDir,
    entryNames: '[name]',
    chunkNames: `chunks/${entries.length === 1 ? entries[0].name : 'shared'}/[name]-[hash]`,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    splitting: true,
    absWorkingDir: REPO_ROOT,
    tsconfig: path.join(REPO_ROOT, 'tsconfig.base.json'),
    logLevel: 'silent',
    logLimit: 0,
    metafile: true,
    ...TASK_BUNDLE_OPTIMIZATION,
    sourcemap: sourcemap ? 'linked' : false,
    sourcesContent: false,
    external: EXTERNALS,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': '__kbn_import_meta_url',
      __KBN_VERSION__: JSON.stringify(version),
    },
    banner: {
      js: [
        'import { createRequire as __kbn_createRequire } from "node:module";',
        'import { fileURLToPath as __kbn_fileURLToPath } from "node:url";',
        'import { dirname as __kbn_dirname } from "node:path";',
        'var require=__kbn_createRequire(import.meta.url),',
        '__filename=__kbn_fileURLToPath(import.meta.url),',
        '__dirname=__kbn_dirname(__filename),__kbn_import_meta_url=import.meta.url;',
      ].join(''),
    },
    loader: {
      '.md': 'text',
      '.txt': 'text',
      '.text': 'text',
      '.html': 'text',
      '.yaml': 'text',
      '.css': 'empty',
      '.svg': 'empty',
      '.png': 'empty',
      '.node': 'empty',
    },
    plugins: [
      taskEntriesPlugin,
      uiSharedDepsStubPlugin,
      nativeApmAgentPlugin,
      pureWorkspacePlugin,
      peggyPlugin,
      repoInfoPlugin(version),
    ],
  });
  const files = Object.keys(result.metafile.outputs).map((file) => path.resolve(REPO_ROOT, file));
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue;
    // V8 retains each loaded chunk's source; keep every chunk at one byte per character.
    fs.writeFileSync(file, escapeNonLatin1(fs.readFileSync(file, 'utf8')));
  }
  return prepared.map(({ entry, featureFlags }) => {
    const outfile = path.join(outDir, `${entry.name}.mjs`);
    const bundleFiles = getBundleOutputs(result.metafile, outfile);
    return {
      name: entry.name,
      runtime,
      outfile,
      bytes: bundleFiles
        .filter((file) => file.endsWith('.mjs'))
        .reduce((total, file) => total + fs.statSync(file).size, 0),
      files: bundleFiles,
      startupBytes: getStartupOutputs(result.metafile, outfile).reduce(
        (total, file) => total + fs.statSync(file).size,
        0
      ),
      entry,
      featureFlags,
      ...(metafile ? { metafile: result.metafile } : {}),
    };
  });
};

/** Builds one task entry with the same graph and metadata as a complete package. */
const buildTaskBundle = async ({ entry, ...options }) => {
  const [result] = await buildTaskBundles({ entries: [entry], ...options });
  return result;
};

/** The task type a file exports as `taskType`; loads it, so it needs the transpiler. */
const readTaskType = (file) => createRequire(__filename)(file).taskType.type;

/** Writes `manifest.json`: which task type each bundle serves, read by Kibana's supervisor. */
const writeManifest = (results, outDir = OUT_DIR, kibanaVersion) => {
  const manifest = {
    kibanaVersion: kibanaVersion ?? require('@kbn/repo-info').kibanaPackageJson.version,
    runtime: results[0]?.runtime,
    bundles: Object.fromEntries(
      results.map(({ entry, name, bytes, outfile, files, startupBytes, featureFlags }) => [
        name,
        {
          file: path.relative(outDir, outfile),
          files: files.map((file) => path.relative(outDir, file)),
          taskType: readTaskType(entry.file),
          bytes,
          startupBytes,
          featureFlags,
        },
      ])
    ),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

module.exports = {
  TASK_BUNDLE_OPTIMIZATION,
  OUT_DIR,
  getTaskBundleEntries,
  getContributionFiles,
  resolveTaskContributions,
  collectTaskFeatureFlags,
  getStartupOutputs,
  buildTaskBundle,
  buildTaskBundles,
  getBundleOutputs,
  writeManifest,
};
