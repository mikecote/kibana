/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '@kbn/repo-info';

export interface TaskRuntimeDependencies {
  readonly files: readonly string[];
  readonly bytes: number;
}

interface RuntimePackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readManifest = (file: string): RuntimePackageManifest =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimePackageManifest;

const copiedRuntimes = new Map<string, TaskRuntimeDependencies>();
const MARKER = '.kbn_task_runtime.json';

const findPackageRoot = (name: string, resolver: NodeJS.Require): string | undefined => {
  try {
    return path.dirname(resolver.resolve(`${name}/package.json`));
  } catch {
    const entry = resolver.resolve(name);
    if (!path.isAbsolute(entry)) return undefined;
    let directory = path.dirname(entry);
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest) && readManifest(manifest).name === name) {
        return directory;
      }
      directory = path.dirname(directory);
    }
    throw new Error(`Unable to locate the installed runtime package ${name}`);
  }
};

/** Copies the native APM SDK and its installed production dependencies into a portable artifact. */
export const copyTaskRuntimeDependencies = (outDir: string): TaskRuntimeDependencies => {
  const destination = path.resolve(outDir, 'node_modules');
  const marker = path.join(destination, MARKER);
  const cached = copiedRuntimes.get(destination);
  if (cached && fs.existsSync(marker)) return cached;
  if (fs.existsSync(destination) && !fs.existsSync(marker)) {
    throw new Error(
      `Refusing to replace a node_modules directory not owned by task bundles: ${destination}`
    );
  }
  const sourceModules = fs.realpathSync(path.join(REPO_ROOT, 'node_modules'));
  if (destination === sourceModules)
    throw new Error('Task runtime output cannot replace Kibana dependencies');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ package: 'elastic-apm-node' }));
  const seen = new Set<string>();
  const copy = (name: string, resolver: NodeJS.Require, optional: boolean = false): void => {
    let root: string | undefined;
    try {
      root = findPackageRoot(name, resolver);
    } catch (error) {
      if (
        optional &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'MODULE_NOT_FOUND'
      )
        return;
      throw error;
    }
    if (!root || seen.has(root)) return;
    const relative = path.relative(sourceModules, fs.realpathSync(root));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Native task runtime package ${name} is outside installed dependencies`);
    }
    seen.add(root);
    fs.cpSync(root, path.join(destination, relative), {
      recursive: true,
      dereference: true,
      filter: (source) => source === root || path.basename(source) !== 'node_modules',
    });
    const manifestPath = path.join(root, 'package.json');
    const manifest = readManifest(manifestPath);
    const packageRequire = createRequire(manifestPath);
    const optionalDependencies = manifest.optionalDependencies ?? {};
    for (const dependency of Object.keys({ ...manifest.dependencies, ...optionalDependencies })) {
      copy(dependency, packageRequire, Object.hasOwn(optionalDependencies, dependency));
    }
  };
  try {
    copy('elastic-apm-node', createRequire(path.join(REPO_ROOT, 'package.json')));
    const runtime: { files: string[]; bytes: number } = { files: [], bytes: 0 };
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else {
          runtime.files.push(path.relative(outDir, file).split(path.sep).join('/'));
          runtime.bytes += fs.statSync(file).size;
        }
      }
    };
    visit(destination);
    runtime.files.sort();
    copiedRuntimes.set(destination, runtime);
    return runtime;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
};
