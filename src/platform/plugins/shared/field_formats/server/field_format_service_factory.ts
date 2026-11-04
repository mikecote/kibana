/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { has } from 'lodash';
import type { IUiSettingsClient } from '@kbn/core/server';
import type { FieldFormatInstanceType } from '../common';
import { FieldFormatsRegistry } from '../common';

/**
 * Builds the registry of field formats for the ui settings of a scope (a space), which is what
 * `fieldFormats.fieldFormatServiceFactory` is. A task process uses it without the plugin.
 */
export const createFieldFormatServiceFactory =
  (fieldFormats: FieldFormatInstanceType[]) =>
  async (uiSettings: IUiSettingsClient): Promise<FieldFormatsRegistry> => {
    const fieldFormatsRegistry = new FieldFormatsRegistry();
    const coreUiConfigs = await uiSettings.getAll();
    const registeredUiSettings = uiSettings.getRegistered();
    const uiConfigs = { ...coreUiConfigs };

    Object.keys(registeredUiSettings).forEach((key) => {
      if (has(uiConfigs, key) && registeredUiSettings[key].type === 'json') {
        uiConfigs[key] = JSON.parse(uiConfigs[key]);
      }
    });

    fieldFormatsRegistry.init((key: string) => uiConfigs[key], {}, fieldFormats);

    return fieldFormatsRegistry;
  };
