/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PluginInitializerContext, CoreSetup, CoreStart, Plugin } from '@kbn/core/server';
import type { FieldFormatsStart, FieldFormatsSetup } from './types';
import { DateFormat, DateNanosFormat } from './lib/converters';
import type { FieldFormatInstanceType } from '../common';
import { baseFormatters } from '../common';
import { createFieldFormatServiceFactory } from './field_format_service_factory';
import { getUiSettings } from './ui_settings';

export class FieldFormatsPlugin implements Plugin<FieldFormatsSetup, FieldFormatsStart> {
  private readonly fieldFormats: FieldFormatInstanceType[] = [
    DateFormat,
    DateNanosFormat,
    ...baseFormatters,
  ];

  constructor(initializerContext: PluginInitializerContext) {}

  public setup(core: CoreSetup) {
    core.uiSettings.register(getUiSettings());

    return {
      register: (customFieldFormat: FieldFormatInstanceType) =>
        this.fieldFormats.push(customFieldFormat),
    };
  }

  public start(core: CoreStart) {
    return {
      fieldFormatServiceFactory: createFieldFormatServiceFactory(this.fieldFormats),
    };
  }

  public stop() {}
}
