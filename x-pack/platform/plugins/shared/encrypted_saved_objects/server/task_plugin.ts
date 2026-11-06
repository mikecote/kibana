/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskPluginInitializer } from '@kbn/core-plugins-server-internal';

import type { ConfigType } from './config';
import { createEncryptedSavedObjectsRuntime } from './create_runtime';
import type { EncryptedSavedObjectsPluginSetup, EncryptedSavedObjectsPluginStart } from './types';

export const taskPlugin: TaskPluginInitializer<
  EncryptedSavedObjectsPluginSetup,
  EncryptedSavedObjectsPluginStart
> = (context) => {
  let runtime: ReturnType<typeof createEncryptedSavedObjectsRuntime> | undefined;
  return {
    setup(core) {
      runtime = createEncryptedSavedObjectsRuntime({
        config: context.config.get<ConfigType>(),
        logger: context.logger.get(),
        savedObjects: core.savedObjects,
        getCoreStart: async () => (await core.getStartServices())[0],
      });
      return runtime.setup;
    },
    start() {
      if (!runtime) throw new Error('Encrypted saved objects must be set up before start.');
      return runtime.start;
    },
  };
};
