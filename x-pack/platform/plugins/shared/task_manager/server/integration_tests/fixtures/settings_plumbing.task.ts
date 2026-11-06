/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { defineTaskType } from '../../task_type_module';

export const PLUMBING_TASK_TYPE = 'test:settings_plumbing';
export const UI_SETTING = 'test:plumbing_setting';
export const GLOBAL_UI_SETTING = 'test:plumbing_global_setting';
/** The ids this module says it registered, for the parity guard. */
export const PLUMBING_PARITY_KIND = 'plumbingThings';
export const PLUMBING_REGISTERED_IDS = ['a', 'b'];

/**
 * Reads what Kibana sends a process besides the run itself: a ui setting and a global ui setting
 * (with their overrides), and the public base URL.
 */
export const taskType = defineTaskType({
  type: PLUMBING_TASK_TYPE,
  title: 'Settings plumbing test',
  uiSettings: {
    defaults: [
      {
        [UI_SETTING]: { name: 'setting', value: 'default', schema: schema.string(), category: [] },
      },
    ],
    globalDefaults: [
      {
        [GLOBAL_UI_SETTING]: {
          name: 'global setting',
          value: 'global default',
          schema: schema.string(),
          category: [],
        },
      },
    ],
  },
  parity: [{ kind: PLUMBING_PARITY_KIND, getIds: () => PLUMBING_REGISTERED_IDS }],
  createTaskRunner: (_context, host) => ({
    run: async () => {
      const soClient = host.savedObjects.getUnsafeInternalClient();
      return {
        state: {
          setting: await host.uiSettings!.asScopedToClient(soClient).get(UI_SETTING),
          globalSetting: await host
            .uiSettings!.globalAsScopedToClient(soClient)
            .get(GLOBAL_UI_SETTING),
          publicBaseUrl: host.server.publicBaseUrl ?? null,
        },
      };
    },
  }),
});
