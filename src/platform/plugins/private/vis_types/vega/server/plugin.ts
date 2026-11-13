/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type {
  PluginInitializerContext,
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
} from '@kbn/core/server';
import { registerVegaEmbeddable } from './embeddable_contribution';
import type {
  VisTypeVegaPluginSetupDependencies,
  VisTypeVegaPluginSetup,
  VisTypeVegaPluginStart,
} from './types';
import { VEGA_STANDALONE_EMBEDDABLE_FLAG } from '../common/constants';

export class VisTypeVegaPlugin implements Plugin<VisTypeVegaPluginSetup, VisTypeVegaPluginStart> {
  private readonly logger: Logger;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  public setup(core: CoreSetup, { embeddable }: VisTypeVegaPluginSetupDependencies) {
    core
      .getStartServices()
      .then(async ([{ featureFlags }]) => {
        const standaloneEmbeddableEnabled = await firstValueFrom(
          featureFlags.getBooleanValue$(VEGA_STANDALONE_EMBEDDABLE_FLAG, false)
        );
        registerVegaEmbeddable(embeddable, () => standaloneEmbeddableEnabled, this.logger);
      })
      .catch(() => {});
    return {};
  }

  public start(core: CoreStart) {
    return {};
  }
}
