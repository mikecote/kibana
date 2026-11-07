/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock } from '@kbn/core/server/mocks';
import { expressionsPluginMock } from '@kbn/expressions-plugin/server/mocks';
import { ContentManagementPlugin } from '@kbn/content-management-plugin/server/plugin';
import {
  createFieldFormatsSetupMock,
  createFieldFormatsStartMock,
} from '@kbn/field-formats-plugin/server/mocks';
import { DataViewsServerPlugin } from './plugin';

it.each([false, true])(
  'captures the actual startup configuration and rollup registration (enabled=%s)',
  (enabled) => {
    const initializer = coreMock.createPluginInitializerContext({
      dataTiersExcludedForFields: enabled,
      fieldListCachingEnabled: enabled,
      scriptedFieldsEnabled: enabled,
      hasEsDataTimeout: 5000,
    });
    const core = coreMock.createSetup();
    const contentManagement = new ContentManagementPlugin(
      coreMock.createPluginInitializerContext()
    ).setup(core, {});
    const plugin = new DataViewsServerPlugin(initializer);
    const setup = plugin.setup(core, {
      expressions: expressionsPluginMock.createSetupContract(),
      fieldFormats: createFieldFormatsSetupMock(),
      contentManagement,
    });
    expect(() => setup.getTaskProcessSettings()).toThrow('have not started');
    if (enabled) setup.enableRollups();
    const start = plugin.start(coreMock.createStart(), {
      fieldFormats: createFieldFormatsStartMock(),
      logger: initializer.logger.get(),
    });
    expect(setup.getTaskProcessSettings()).toEqual({
      dataTiersExcludedForFields: enabled,
      fieldListCachingEnabled: enabled,
      scriptedFieldsEnabled: start.getScriptedFieldsEnabled(),
      rollupsEnabled: enabled,
    });
    const snapshot = setup.getTaskProcessSettings();
    snapshot.scriptedFieldsEnabled = !enabled;
    expect(setup.getTaskProcessSettings().scriptedFieldsEnabled).toBe(enabled);
  }
);
