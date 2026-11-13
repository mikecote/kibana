/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableSetup, EmbeddableRegistryDefinition } from '@kbn/embeddable-plugin/server';
import type { LensEmbeddableRegistryDefinition } from './embeddable/types';

/** Registers Lens's persisted state factory with the embeddable registry. */
export const registerLensEmbeddableFactory = (
  embeddable: EmbeddableSetup,
  factory: LensEmbeddableRegistryDefinition
): void => {
  embeddable.registerEmbeddableFactory(factory as unknown as EmbeddableRegistryDefinition);
};
