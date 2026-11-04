/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { IUiSettingsClient } from '@kbn/core/server';
import { baseFormatters } from '../common';
import { DateFormat } from './lib/converters';
import { createFieldFormatServiceFactory } from './field_format_service_factory';

describe('createFieldFormatServiceFactory', () => {
  it('builds a registry from the formats and the ui settings of the scope', async () => {
    const getAll = jest.fn().mockResolvedValue({
      dateFormat: 'MMM D, YYYY',
      'format:defaultTypeMap': JSON.stringify({ number: { id: 'number' } }),
    });
    const uiSettings = {
      getAll,
      getRegistered: () => ({ 'format:defaultTypeMap': { type: 'json' } }),
    } as unknown as IUiSettingsClient;

    const registry = await createFieldFormatServiceFactory([DateFormat, ...baseFormatters])(
      uiSettings
    );

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(registry.has('date')).toBe(true);
    expect(registry.has('number')).toBe(true);
  });
});
