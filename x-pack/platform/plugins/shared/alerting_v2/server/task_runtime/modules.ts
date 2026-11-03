/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createToken } from '@kbn/core-di';
import { CoreStart, PluginInitializer } from '@kbn/core-di-server';
import { defineServiceModule } from '@kbn/task-manager-plugin/server/task_runtime';
import { configSchema } from '../config';
import type { PluginConfig } from '../config';
import { EsServiceInternalToken } from '../lib/services/es_service/tokens';

/** The validated `xpack.alerting_v2` config of a task process. */
export const AlertingConfigToken = createToken<PluginConfig>('alerting_v2.Config');

/** `EsServiceInternalToken`: Core's internal Elasticsearch client. Kibana loads this module too. */
export const alertingV2EsModule = defineServiceModule({
  id: 'alertingV2.es',
  load: ({ bind }) => {
    bind(EsServiceInternalToken)
      .toDynamicValue(({ get }) => get(CoreStart('elasticsearch')).client.asInternalUser)
      .inSingletonScope();
  },
});

/** What a task process provides in place of a plugin's initializer context: its config accessor. */
export const alertingV2ConfigModule = defineServiceModule({
  id: 'alertingV2.config',
  config: { path: ['xpack', 'alerting_v2'], schema: configSchema, token: AlertingConfigToken },
  load: ({ bind }) => {
    bind(PluginInitializer('config'))
      .toResolvedValue((config) => ({ get: () => config } as never), [AlertingConfigToken])
      .inSingletonScope();
  },
});
