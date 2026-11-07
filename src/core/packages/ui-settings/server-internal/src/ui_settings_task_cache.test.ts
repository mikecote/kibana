/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { BehaviorSubject } from 'rxjs';
import { schema } from '@kbn/config-schema';
import { mockCoreContext } from '@kbn/core-base-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { savedObjectsClientMock } from '@kbn/core-saved-objects-api-server-mocks';
import { UiSettingsService } from './ui_settings_service';

it.each(['namespace', 'global'] as const)(
  'reads externally changed %s settings through fresh task clients without retaining an earlier execution',
  async (scope) => {
    const context = mockCoreContext.create();
    context.configService.atPath.mockReturnValue(
      new BehaviorSubject({ overrides: {}, globalOverrides: {} })
    );
    const service = new UiSettingsService(context);
    await service.preboot();
    const setup = await service.setupTask({
      savedObjects: savedObjectsServiceMock.createInternalSetupContract(),
    });
    const definition = { taskCacheValue: { value: 'default', schema: schema.string() } };
    if (scope === 'global') setup.registerGlobal(definition);
    else setup.register(definition);
    const start = await service.start();
    const savedObjects = savedObjectsClientMock.create();
    let currentValue = 'first execution';
    savedObjects.get.mockImplementation(async (type, id) => ({
      type,
      id,
      attributes: { buildNum: context.env.packageInfo.buildNum, taskCacheValue: currentValue },
      references: [],
    }));
    try {
      const createClient =
        scope === 'global' ? start.globalAsScopedToClient : start.asScopedToClient;
      expect(await createClient(savedObjects).get('taskCacheValue')).toBe('first execution');
      currentValue = 'written by Kibana';
      expect(await createClient(savedObjects).get('taskCacheValue')).toBe('written by Kibana');
      expect(savedObjects.get).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
    }
  }
);
