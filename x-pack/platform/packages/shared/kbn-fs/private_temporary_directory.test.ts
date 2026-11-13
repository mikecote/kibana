/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createPrivateTemporaryDirectory } from './private_temporary_directory';

it('preserves private runtime bytes, prevents accidental replacement and cleans up', () => {
  const directory = createPrivateTemporaryDirectory('kbn-private-runtime-');
  const contents = Buffer.from([0, 255, 10, 65]);
  const path = directory.writeFile('client.key', contents);
  try {
    expect(statSync(directory.path).mode.toString(8).slice(-3)).toBe('700');
    expect(readFileSync(path)).toEqual(contents);
    expect(statSync(path).mode.toString(8).slice(-3)).toBe('600');
    expect(() => directory.writeFile('client.key', 'replacement')).toThrow();
    expect(readFileSync(path)).toEqual(contents);
  } finally {
    directory.cleanup();
  }
  expect(existsSync(directory.path)).toBe(false);
});

it('rejects directory traversal before creating or writing files', () => {
  expect(() => createPrivateTemporaryDirectory('../outside-')).toThrow('single filename segment');
  const directory = createPrivateTemporaryDirectory('kbn-private-runtime-');
  try {
    for (const name of ['../outside', '/absolute', '..\\outside', '.', '..', '']) {
      expect(() => directory.getPath(name)).toThrow('single filename segment');
      expect(() => directory.writeFile(name, 'data')).toThrow('single filename segment');
    }
  } finally {
    directory.cleanup();
  }
});
