/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { UiSettingsServiceSetup } from '@kbn/core-ui-settings-server';
import type { DataViewsUiRegistrationSettings } from './task_types/data_views_task_process_settings';
import { dataTiersUiSettingsConfig, cacheMaxAge } from './ui_settings';

/** Registers the native data-view UI defaults selected by the plugin's startup configuration. */
export const registerDataViewsUiSettings = (
  uiSettings: Pick<UiSettingsServiceSetup, 'register'>,
  config: DataViewsUiRegistrationSettings
): void => {
  if (config.dataTiersExcludedForFields) uiSettings.register(dataTiersUiSettingsConfig);
  if (config.fieldListCachingEnabled) uiSettings.register(cacheMaxAge);
};
