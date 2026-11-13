/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RemoteWorkerCapabilities } from './remote_worker_capabilities';

it('returns flag declarations from the current native bundle metadata', () => {
  const declarations = { 'sdk.enabled': false };
  const read = jest.fn(() => declarations);
  const root = new RemoteWorkerCapabilities(() => undefined, 'connection', read);
  expect(root.featureFlags('test')).toBe(declarations);
  expect(read).toHaveBeenCalledWith('test');
  expect(root.id()).toBe('connection');
});

it('bounds flag-declaration task types before reading native metadata', () => {
  const read = jest.fn();
  const root = new RemoteWorkerCapabilities(() => undefined, 'connection', read);
  for (const input of ['', 'x'.repeat(1025), {}]) {
    expect(() => Reflect.apply(root.featureFlags, root, [input])).toThrow('Invalid task type');
  }
  expect(read).not.toHaveBeenCalled();
});

it('does not invent declarations when native metadata is missing', () => {
  const root = new RemoteWorkerCapabilities(
    () => undefined,
    'connection',
    () => undefined
  );
  expect(root.featureFlags('missing')).toBeUndefined();
});
