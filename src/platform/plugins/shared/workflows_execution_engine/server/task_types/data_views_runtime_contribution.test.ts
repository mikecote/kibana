/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock } from '@kbn/core/server/mocks';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { getUiSettings } from '@kbn/data-plugin/server/ui_settings';
import { contribution } from './data_views_runtime_contribution';

it.each([true, false])(
  'registers the native search defaults once with validations %s',
  (enabled) => {
    const core = coreMock.createSetup();
    contribution.declares?.registerUiSettings?.(core.uiSettings, {
      dataSearchRuntime: {
        multiSearchDocLink: core.docLinks.links.apis.multiSearch,
        docLinks: core.docLinks,
        search: {
          searchConfig: searchConfigSchema.validate({}),
          uiSettingsValidationsEnabled: enabled,
          rollupsEnabled: false,
        },
      },
      dataViewsRuntime: {
        scriptedFieldsEnabled: false,
        rollupsEnabled: false,
        dataTiersExcludedForFields: true,
        fieldListCachingEnabled: true,
      },
    });
    const registrations = core.uiSettings.register.mock.calls.flatMap(([defaults]) =>
      Object.keys(defaults)
    );
    expect(new Set(registrations).size).toBe(registrations.length);
    expect(registrations).toEqual(
      expect.arrayContaining(Object.keys(getUiSettings(core.docLinks, enabled)))
    );
  }
);
