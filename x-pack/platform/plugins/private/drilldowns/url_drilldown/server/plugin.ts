/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin } from '@kbn/core/server';
import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';

interface SetupDependencies {
  embeddable: EmbeddableSetup;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface StartDependencies {}

import { registerEmbeddableDefinitions } from './embeddable_contribution';

export class UrlDrilldownPlugin
  implements Plugin<void, void, SetupDependencies, StartDependencies>
{
  public setup(core: CoreSetup, { embeddable }: SetupDependencies) {
    registerEmbeddableDefinitions(embeddable);
  }

  public start(core: CoreStart) {}
}
