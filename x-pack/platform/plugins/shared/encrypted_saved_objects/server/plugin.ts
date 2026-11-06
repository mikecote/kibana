/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger, Plugin, PluginInitializerContext } from '@kbn/core/server';

import type { ConfigType } from './config';
import { createEncryptedSavedObjectsRuntime } from './create_runtime';
import { EncryptionKeyRotationService } from './crypto';
import { defineRoutes } from './routes';
import type { EncryptedSavedObjectsPluginSetup, EncryptedSavedObjectsPluginStart } from './types';
export type { EncryptedSavedObjectsPluginSetup, EncryptedSavedObjectsPluginStart } from './types';

export class EncryptedSavedObjectsPlugin
  implements Plugin<EncryptedSavedObjectsPluginSetup, EncryptedSavedObjectsPluginStart>
{
  private readonly logger: Logger;
  private runtime?: ReturnType<typeof createEncryptedSavedObjectsRuntime>;
  constructor(private readonly initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }
  public setup(core: CoreSetup): EncryptedSavedObjectsPluginSetup {
    const config = this.initializerContext.config.get<ConfigType>();
    const runtime = createEncryptedSavedObjectsRuntime({
      config,
      logger: this.logger,
      savedObjects: core.savedObjects,
      getCoreStart: async () => (await core.getStartServices())[0],
    });
    this.runtime = runtime;
    defineRoutes({
      router: core.http.createRouter(),
      logger: this.initializerContext.logger.get('routes'),
      encryptionKeyRotationService: Object.freeze(
        new EncryptionKeyRotationService({
          logger: this.logger.get('key-rotation-service'),
          service: runtime.service,
          getStartServices: core.getStartServices,
        })
      ),
      config,
      buildFlavor: this.initializerContext.env.packageInfo.buildFlavor,
    });
    return runtime.setup;
  }
  public start(): EncryptedSavedObjectsPluginStart {
    if (!this.runtime) throw new Error('Encrypted saved objects must be set up before start.');
    this.logger.debug('Starting plugin');
    return this.runtime.start;
  }
  public stop(): void {
    this.logger.debug('Stopping plugin');
  }
}
