/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import moment from 'moment';
import { ByteSizeValue } from '@kbn/config-schema';
import { reviveSettings, serializeSettings } from './settings';

describe('task process settings', () => {
  it('round-trips durations, byte sizes and dates through JSON', () => {
    const config = {
      timeout: moment.duration(5, 'm'),
      max: new ByteSizeValue(1024),
      at: new Date('2026-01-01T00:00:00.000Z'),
      nested: { list: [moment.duration(1, 's'), 'a', 1, true, null] },
    };
    const revived = reviveSettings(
      JSON.parse(JSON.stringify(serializeSettings(config)))
    ) as typeof config;
    expect(moment.isDuration(revived.timeout)).toBe(true);
    expect(revived.timeout.asMinutes()).toBe(5);
    expect(revived.max).toBeInstanceOf(ByteSizeValue);
    expect(revived.max.getValueInBytes()).toBe(1024);
    expect(revived.at).toEqual(config.at);
    expect((revived.nested.list[0] as moment.Duration).asSeconds()).toBe(1);
    expect(revived.nested.list.slice(1)).toEqual(['a', 1, true, null]);
  });

  it('drops functions and undefined and rejects unsupported values', () => {
    expect(serializeSettings({ a: 1, f: () => 1, u: undefined })).toEqual({ a: 1 });
    expect(() => serializeSettings({ s: new Set() })).toThrow(/Set/);
  });
});
