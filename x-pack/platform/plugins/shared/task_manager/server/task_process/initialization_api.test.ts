/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { InitializationApi } from './initialization_api';
import { digestValue, prepareLocalInit } from './init_inventory';

it('compares both directions against live Main registrations, including reused dispatches', () => {
  let expected = ['one'];
  const api = new InitializationApi({
    read: async () => prepareLocalInit({}),
    getParity: () => [{ kind: 'agentBuilder.tools', ids: expected }],
  });
  const ids = { 'agentBuilder.tools': ['one'] };
  const digest = digestValue(ids);
  expect(api.registrations('agentBuilder.tools', digest, ids)).toBeNull();
  expect(() => api.assertCurrent()).not.toThrow();
  expected = ['one', 'two'];
  expect(() => api.assertCurrent()).toThrow('missing [two]');
  expect(api.registrations('agentBuilder.tools', digest)).toContain('missing [two]');
  expected = [];
  expect(api.registrations('agentBuilder.tools', digest)).toContain('extra [one]');
  expect(() => api.registrations('agentBuilder.tools', 'changed')).toThrow('Unknown native');
  expect(() =>
    api.registrations('agentBuilder.tools', digestValue({ 'agentBuilder.tools': [] }), ids)
  ).toThrow('Invalid native');
  const changed = { 'agentBuilder.tools': [] };
  expect(api.registrations('agentBuilder.tools', digestValue(changed), changed)).toBeNull();
});

it('reads boot data once and restricts asset reads to installed digests', async () => {
  const prepared = prepareLocalInit({ settings: { ml: { moduleFiles: { 'a/file': 'content' } } } });
  const read = jest.fn(async () => prepared);
  const api = new InitializationApi({ read, getParity: () => [] });
  await api.inventories();
  expect(await api.content(Object.keys(prepared.content)[0])).toBe('{"a/file":"content"}');
  await expect(api.content('unknown')).rejects.toThrow('Unknown installed');
  expect(read).toHaveBeenCalledTimes(1);
});

it('preserves missing-only workflow policy while refreshing Main truth each dispatch', () => {
  let expected = ['main'];
  const api = new InitializationApi({
    read: async () => prepareLocalInit({}),
    getParity: () => [{ kind: 'workflow.steps', ids: expected }],
  });
  const ids = {
    'workflow.steps': ['main', 'proposals.createProposal', 'threat_intel.fetch_source'],
  };
  expect(api.registrations('workflow.steps', digestValue(ids), ids)).toBeNull();
  expect(() => api.assertCurrent()).not.toThrow();
  expected = ['main', 'new'];
  expect(() => api.assertCurrent()).toThrow('missing [new]');
});
