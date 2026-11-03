/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Inputs a task bundle must not contain. A task type's closure is only small while nothing pulls in
 * Core's server, the HTTP stack or the plugin system. Matched against esbuild metafile input paths,
 * so the check is the same for the source tree and the built tree.
 */
const FORBIDDEN_INPUTS = [
  {
    id: '@kbn/core/server',
    match: /\/src\/core\/packages\/core\/server\/index\.[jt]s$/,
    reason: "Core's server barrel loads the whole server; import the package that has the symbol",
  },
  {
    id: '@kbn/core-root-server-internal',
    match: /\/src\/core\/packages\/root\/server-internal\//,
    reason: 'the Kibana server itself',
  },
  {
    id: '@kbn/core-logging-server-internal',
    match: /\/src\/core\/packages\/logging\/server-internal\//,
    reason: 'logging system (OpenTelemetry exporters, appenders); use the task host logger',
  },
  {
    id: '@kbn/core-http-server-internal',
    match: /\/src\/core\/packages\/http\/server-internal\/src\/(?!base_path_service)/,
    reason: 'the hapi HTTP server',
  },
  {
    id: '@kbn/core-http-router-server-internal (router)',
    match: /\/src\/core\/packages\/http\/router-server-internal\/src\/router\.[jt]s$/,
    reason: 'the router pulls in elastic-apm-node and hapi; import src/request_guards',
  },
  {
    id: '@kbn/core-plugins-server-internal',
    match: /\/src\/core\/packages\/plugins\/server-internal\/(index|src\/plugins_service)\.[jt]s$/,
    reason: 'plugin discovery and the plugin system',
  },
  {
    id: '@kbn/task-manager-plugin/server (barrel)',
    match: /\/task_manager\/server\/(index|plugin)\.[jt]s$/,
    reason: "Task Manager's barrel loads the plugin; import /server/task_helpers or /server/task",
  },
  {
    id: '@kbn/repo-info',
    match: /\/kbn-repo-info\//,
    reason: 'walks the file system for the repo root; use the build-time version define',
  },
  { id: '@kbn/repo-packages', match: /\/kbn-repo-packages\//, reason: 'reads package manifests' },
  {
    id: 'elastic-apm-node',
    match: /\/node_modules\/elastic-apm-node\//,
    reason: 'APM instruments through require hooks, which a bundle cannot keep',
  },
  { id: 'react', match: /\/node_modules\/react(-dom)?\//, reason: 'UI code' },
  {
    id: '@opentelemetry/sdk',
    match: /\/node_modules\/@opentelemetry\/sdk-(?!trace-base)/,
    reason: 'OpenTelemetry SDK',
  },
];

/**
 * Returns, for each forbidden input found in the metafile, the shortest import chain from the entry
 * to it, so the offending import is obvious.
 */
const walk = (metafile, entryPaths, visit) => {
  const inputs = metafile.inputs;
  const starts = Object.keys(inputs).filter((key) =>
    entryPaths.some((entry) => `/${key}`.startsWith(`/${entry}.`) || key === entry)
  );
  const parent = new Map(starts.map((start) => [start, null]));
  const queue = [...starts];
  while (queue.length) {
    const file = queue.shift();
    const chain = () => {
      const out = [];
      for (let cursor = file; cursor; cursor = parent.get(cursor)) out.unshift(cursor);
      return out;
    };
    if (visit(file, chain)) return;
    for (const imp of inputs[file]?.imports ?? []) {
      if (imp.external || parent.has(imp.path)) continue;
      parent.set(imp.path, file);
      queue.push(imp.path);
    }
  }
};

/** The shortest import chain from the entries to the first input whose path contains `needle`. */
const shortestChain = (metafile, entryPaths, needle) => {
  let found;
  walk(metafile, entryPaths, (file, chain) => {
    if (!file.includes(needle)) return false;
    found = chain();
    return true;
  });
  return found;
};

const findForbiddenInputsLegacy = (metafile, entryPaths, allowed = []) => {
  const inputs = metafile.inputs;
  const starts = Object.keys(inputs).filter((key) =>
    entryPaths.some((entry) => `/${key}`.startsWith(`/${entry}.`) || key === entry)
  );
  const parent = new Map(starts.map((start) => [start, null]));
  const queue = [...starts];
  const hits = [];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    const rule = FORBIDDEN_INPUTS.find((r) => r.match.test(`/${file}`) && !allowed.includes(r.id));
    if (rule && !seen.has(rule.id)) {
      seen.add(rule.id);
      const chain = [];
      for (let cursor = file; cursor; cursor = parent.get(cursor)) chain.unshift(cursor);
      hits.push({ id: rule.id, reason: rule.reason, chain });
    }
    for (const imp of inputs[file]?.imports ?? []) {
      if (imp.external || parent.has(imp.path)) continue;
      parent.set(imp.path, file);
      queue.push(imp.path);
    }
  }
  return hits;
};

const findForbiddenInputs = findForbiddenInputsLegacy;

module.exports = { FORBIDDEN_INPUTS, findForbiddenInputs, shortestChain };
