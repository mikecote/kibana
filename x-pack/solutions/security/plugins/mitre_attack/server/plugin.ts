/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { MitreAttackConfig } from './config';
import type {
  MitreAttackApiRequestHandlerContext,
  MitreAttackRequestHandlerContext,
  MitreAttackServerSetup,
  MitreAttackServerStart,
} from './types';
import { mitreAttackEntityType } from './saved_objects';
import { createMitreAttackRunServices } from './create_mitre_attack_run_services';
import type { MitreAttackDataClient } from './services/mitre_attack_data_client/mitre_attack_data_client_interface';
import { registerRoutes } from './routes';

export class MitreAttackPlugin implements Plugin<MitreAttackServerSetup, MitreAttackServerStart> {
  private readonly config: MitreAttackConfig;
  private readonly logger: Logger;
  private mitreDataClient?: MitreAttackDataClient;

  constructor(context: PluginInitializerContext<MitreAttackConfig>) {
    this.config = context.config.get<MitreAttackConfig>();
    this.logger = context.logger.get();
  }

  public setup(core: CoreSetup): MitreAttackServerSetup {
    if (!this.config.managedSourceEnabled) {
      return {};
    }

    core.savedObjects.registerType(mitreAttackEntityType);

    const router = core.http.createRouter<MitreAttackRequestHandlerContext>();
    core.http.registerRouteHandlerContext<MitreAttackRequestHandlerContext, 'mitreAttack'>(
      'mitreAttack',
      (): MitreAttackApiRequestHandlerContext => ({
        getMitreDataClient: () => this.mitreDataClient,
      })
    );
    registerRoutes({ router, logger: this.logger });

    return {};
  }

  public start(core: CoreStart): MitreAttackServerStart {
    if (!this.config.managedSourceEnabled) {
      return {};
    }

    const services = createMitreAttackRunServices({
      savedObjects: core.savedObjects,
      logger: this.logger,
    });
    this.mitreDataClient = services.getMitreDataClient?.();
    return services;
  }

  public stop(): void {}
}
