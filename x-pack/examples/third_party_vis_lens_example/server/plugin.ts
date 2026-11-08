/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { Plugin, CoreSetup } from '@kbn/core/server';
import type { LensServerPluginSetup } from '@kbn/lens-plugin/server';
import { getRotatingNumberMigrations } from './visualization_migrations';

// this plugin's dependencies
export interface Dependencies {
  lens: LensServerPluginSetup;
}

export class ThirdPartyVisLensExamplePlugin implements Plugin<void, void, Dependencies> {
  public setup(core: CoreSetup, { lens }: Dependencies) {
    lens.registerVisualizationMigration('rotatingNumber', getRotatingNumberMigrations);
  }

  public start() {}
  public stop() {}
}
