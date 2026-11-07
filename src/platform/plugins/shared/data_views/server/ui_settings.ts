/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';
import { schema } from '@kbn/config-schema';
import type { UiSettingsParams } from '@kbn/core/server';
import { META_FIELDS, DATA_VIEWS_FIELDS_EXCLUDED_TIERS } from '../common/constants';
import { DEFAULT_FIELD_CACHE_FRESHNESS } from './constants';

export const dataTiersUiSettingsConfig: Record<string, UiSettingsParams> = {
  [DATA_VIEWS_FIELDS_EXCLUDED_TIERS]: {
    name: i18n.translate('dataViews.advancedSettings.dataTiersName', {
      defaultMessage: 'Data tiers excluded from field requests',
    }),
    value: '',
    type: 'string',
    description: i18n.translate('dataViews.advancedSettings.dataTiersText', {
      defaultMessage:
        'Exclude fields from specified tiers (such as data_frozen) for faster performance. Comma delimit to exclude multiple tiers - data_warm,data_cold',
    }),
    schema: schema.string(),
  },
};

export const cacheMaxAge = {
  'data_views:cache_max_age': {
    name: i18n.translate('dataViews.advancedSettings.cacheMaxAgeTitle', {
      defaultMessage: 'Field cache max age (in seconds)',
    }),
    value: DEFAULT_FIELD_CACHE_FRESHNESS,
    description: i18n.translate('dataViews.advancedSettings.cacheMaxAgeText', {
      defaultMessage:
        'Sets how long data view fields API requests are cached in seconds. A value of 0 turns off caching. Modifying this value may not take immediate effect, users need to clear browser cache or wait until the current cache expires. To see immediate changes, try a hard reload of Kibana.',
    }),
    schema: schema.number(),
  },
};

export const dataViewServiceUiSettings: Record<string, UiSettingsParams> = {
  [META_FIELDS]: {
    name: i18n.translate('data.advancedSettings.metaFieldsTitle', {
      defaultMessage: 'Meta fields',
    }),
    value: ['_source', '_id', '_index', '_score', '_ignored'],
    description: i18n.translate('data.advancedSettings.metaFieldsText', {
      defaultMessage:
        'Fields that exist outside of _source to merge into our document when displaying it',
    }),
    schema: schema.arrayOf(schema.string(), { maxSize: 100 }),
  },
  defaultIndex: {
    name: i18n.translate('data.advancedSettings.defaultIndexTitle', {
      defaultMessage: 'Default data view',
    }),
    value: '',
    type: 'string',
    description: i18n.translate('data.advancedSettings.defaultIndexText', {
      defaultMessage: 'Used by discover and visualizations when a data view is not set.',
    }),
    schema: schema.string(),
  },
};
