/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  captureModuleFiles,
  createNativeModuleFiles,
  createSnapshotModuleFiles,
} from './module_files';

it('captures exactly the installed native module directories, manifests and referenced files', async () => {
  const native = createNativeModuleFiles();
  const snapshot = await captureModuleFiles();
  const detached = createSnapshotModuleFiles(JSON.parse(JSON.stringify(snapshot)));
  const directories = (await native.listDirectories()).sort();
  expect(await detached.listDirectories()).toEqual(directories);
  expect(directories).toContain('logs_ui_analysis');
  for (const [path, content] of Object.entries(snapshot)) {
    expect(await native.read(path)).toBe(content);
    expect(await detached.read(path)).toBe(content);
  }
  expect(Object.keys(snapshot)).toEqual(
    expect.arrayContaining([
      'logs_ui_analysis/manifest.json',
      'logs_ui_analysis/ml/log_entry_rate.json',
      'logs_ui_analysis/logo.json',
    ])
  );
});

it('rejects missing dispatched files instead of consulting local assets', async () => {
  const files = createSnapshotModuleFiles({});
  await expect(files.read('logs_ui_analysis/manifest.json')).rejects.toThrow(
    'ML module asset was not dispatched'
  );
  await expect(files.read('toString')).rejects.toThrow('ML module asset was not dispatched');
});

it('defers digest fetch until use and shares the parsed module files across reads', async () => {
  const reference = { __kind: 'content' as const, digest: 'installed', size: 20 };
  const readContent = jest.fn(async () => JSON.stringify({ 'module/file': 'installed' }));
  const files = createSnapshotModuleFiles(reference, readContent);
  expect(readContent).not.toHaveBeenCalled();
  expect(await files.listDirectories()).toEqual(['module']);
  expect(await files.read('module/file')).toBe('installed');
  expect(readContent).toHaveBeenCalledTimes(1);
  expect(readContent).toHaveBeenCalledWith(reference);
});
