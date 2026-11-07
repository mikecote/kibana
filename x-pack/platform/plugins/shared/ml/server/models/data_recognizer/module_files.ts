/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DataRecognizerModuleFiles {
  listDirectories: () => Promise<string[]>;
  read: (relativePath: string) => Promise<string>;
}

export type DataRecognizerModuleSnapshot = Readonly<Record<string, string>>;

/** Reads the module assets installed alongside the native ML plugin. */
export const createNativeModuleFiles = (): DataRecognizerModuleFiles => {
  const root = join(__dirname, 'modules');
  return {
    listDirectories: async () =>
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name),
    read: (relativePath) => readFile(join(root, relativePath), 'utf8'),
  };
};

/** Captures the installed module assets for a standalone worker. */
export const captureModuleFiles = async (): Promise<DataRecognizerModuleSnapshot> => {
  const root = join(__dirname, 'modules');
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile())
        files[relativePath] = await readFile(join(root, relativePath), 'utf8');
    }
  };
  await visit('');
  return files;
};

/** Serves the dispatched assets without consulting the worker's filesystem. */
export const createSnapshotModuleFiles = (
  files: DataRecognizerModuleSnapshot
): DataRecognizerModuleFiles => ({
  listDirectories: async () =>
    [
      ...new Set(
        Object.keys(files)
          .filter((path) => path.includes('/'))
          .map((path) => path.split('/')[0])
      ),
    ].sort(),
  read: async (relativePath) => {
    if (!Object.hasOwn(files, relativePath))
      throw new Error(`ML module asset was not dispatched: ${relativePath}`);
    return files[relativePath];
  },
});
