/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PrivateTemporaryDirectory {
  readonly path: string;
  getPath: (name: string) => string;
  writeFile: (name: string, content: string | NodeJS.ArrayBufferView) => string;
  cleanup: () => void;
}

const validateSegment = (name: string): void => {
  if (!name || name.length > 128 || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error('Private temporary files require a single filename segment');
  }
};

/** Creates an isolated directory for private runtime files with explicit cleanup. */
export const createPrivateTemporaryDirectory = (prefix: string): PrivateTemporaryDirectory => {
  validateSegment(prefix);
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const getPath = (name: string): string => {
    validateSegment(name);
    return join(directory, name);
  };
  return {
    path: directory,
    getPath,
    writeFile: (name, content) => {
      const path = getPath(name);
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
      return path;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};
