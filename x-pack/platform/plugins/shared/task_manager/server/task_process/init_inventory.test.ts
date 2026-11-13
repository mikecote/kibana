/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { prepareLocalInit, hydrateInventories } from './init_inventory';
import { deduplicateSettings } from './shared_settings';
import type { TaskProcessInit } from './wire';

it('replaces live metadata and static assets but preserves facts and schema inputs', () => {
  const features = [{ id: 'search' }];
  const files = { 'module/manifest.json': '{"id":"module"}' };
  const source = {
    ...deduplicateSettings({
      spacesRuntime: { features, enabled: true },
      ml: { spaces: { features }, moduleFiles: files },
      mlAgentBuilder: { moduleFiles: files },
      taskManager: {
        scheduling: {
          definitions: [{ type: 'test' }],
          middlewareIds: ['one'],
          securityEnabled: true,
        },
      },
      actions: { secret: 'inline' },
    }),
    parity: [{ kind: 'workflow.steps', ids: ['test'] }],
  };
  const packed = prepareLocalInit(source);
  expect(packed.init.parity).toBeUndefined();
  expect(packed.init.sharedSettings).toBeUndefined();
  expect(Object.keys(packed.content)).toHaveLength(1);
  expect(packed.init.settings?.actions).toEqual({ secret: 'inline' });
  expect(packed.init.settings?.ml).toMatchObject({
    moduleFiles: { __kind: 'content', size: JSON.stringify(files).length },
  });
  const init = packed.init as TaskProcessInit;
  hydrateInventories(init, packed.inventories);
  expect(init.settings?.spacesRuntime).toEqual({ features, enabled: true });
  expect(init.settings?.taskManager).toMatchObject({
    scheduling: { definitions: [{ type: 'test' }], middlewareIds: ['one'], securityEnabled: true },
  });
  expect(source.parity).toHaveLength(1);
  expect(prepareLocalInit(source).init.localAuthority).toEqual(init.localAuthority);
  expect(
    prepareLocalInit({ ...source, parity: [{ kind: 'workflow.steps', ids: ['changed'] }] }).init
      .localAuthority
  ).not.toEqual(init.localAuthority);
});

it('rejects stale live inventories instead of booting with another revision', () => {
  const packed = prepareLocalInit({ settings: { spacesRuntime: { features: ['one'] } } });
  expect(() =>
    hydrateInventories(packed.init as TaskProcessInit, { 'spacesRuntime.features': ['two'] })
  ).toThrow('Changed or missing');
});
