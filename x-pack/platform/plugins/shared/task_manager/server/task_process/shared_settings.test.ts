/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { deduplicateSettings } from './shared_settings';
import { reviveSettingsByPlugin, serializeSettings } from './settings';

describe('deduplicateSettings', () => {
  const features = [{ id: 'test', name: 'Test feature' }];
  const moduleFiles = { 'module.json': '{"id":"test"}' };
  const settings = {
    spacesRuntime: { features },
    alertingAuthorizationRuntime: { features: [...features] },
    ruleDataViewsCapabilities: { features: [...features] },
    ml: { spaces: { features: [...features] }, moduleFiles },
    mlWorkflowRuntime: { moduleFiles: { ...moduleFiles } },
    mlAgentBuilder: { moduleFiles: { ...moduleFiles } },
  };

  it('ships each repeated inventory once and revives before config validation', () => {
    const packed = deduplicateSettings(
      Object.fromEntries(
        Object.entries(settings).map(([id, value]) => [id, serializeSettings(value)])
      )
    );
    expect(Object.values(packed.sharedSettings)).toEqual([features, moduleFiles]);
    const wire = JSON.parse(JSON.stringify(packed));
    const revived = reviveSettingsByPlugin(wire.settings, wire.sharedSettings);
    expect(revived).toEqual(settings);
    expect(
      schema
        .object({
          features: schema.arrayOf(schema.object({ id: schema.string(), name: schema.string() })),
        })
        .validate(revived.spacesRuntime)
    ).toEqual(settings.spacesRuntime);
    expect(settings.ml.moduleFiles).toEqual(moduleFiles);
    expect(settings.spacesRuntime.features).toEqual(features);
  });

  it('keeps unequal and singleton inventories inline', () => {
    const original = {
      spacesRuntime: { features: [{ id: 'a' }] },
      ml: { spaces: { features: [{ id: 'b' }] }, moduleFiles },
    };
    expect(deduplicateSettings(original)).toEqual({ settings: original, sharedSettings: {} });
  });

  it('preserves legacy snapshots without a shared section', () => {
    expect(reviveSettingsByPlugin(settings)).toEqual(settings);
  });

  it('rejects references missing from the shared section', () => {
    expect(() =>
      reviveSettingsByPlugin({ spacesRuntime: { __kind: 'sharedSetting', key: 'absent' } })
    ).toThrow('Missing shared task process setting: absent');
  });
});
