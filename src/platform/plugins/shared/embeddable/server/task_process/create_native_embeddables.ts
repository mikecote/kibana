/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createEmbeddableServices } from '../create_embeddable_services';
import type { EmbeddableSetup } from '../plugin';
import type { EmbeddableContribution, EmbeddableRegistrationIds } from './embeddable_contribution';

/** Restores the dispatching Main's embeddable registries through native plugin contributions. */
export const createNativeEmbeddables = (
  contributions: readonly EmbeddableContribution[],
  expected: EmbeddableRegistrationIds,
  context: Parameters<EmbeddableContribution['register']>[1] = {}
): ReturnType<typeof createEmbeddableServices> => {
  const native = createEmbeddableServices();
  const setup: EmbeddableSetup = {
    ...native.setup,
    registerEmbeddableFactory: (factory) => {
      if (expected.factories.includes(factory.id)) native.setup.registerEmbeddableFactory(factory);
    },
    registerEmbeddableServerDefinition: (type, definition) => {
      if (expected.definitions.includes(type))
        native.setup.registerEmbeddableServerDefinition(type, definition);
    },
    registerDrilldown: (type, drilldown) => {
      if (expected.drilldowns.includes(type)) native.setup.registerDrilldown(type, drilldown);
    },
  };
  for (const contribution of contributions) contribution.register(setup, context);
  const actual = native.getRegistrationIds();
  for (const kind of ['factories', 'definitions', 'drilldowns'] as const) {
    const missing = expected[kind].filter((id) => !actual[kind].includes(id));
    if (missing.length)
      throw new Error(`Native embeddable ${kind} are missing: ${missing.join(', ')}`);
  }
  for (const [id, versions] of Object.entries(expected.migrations ?? {})) {
    if (JSON.stringify(versions) !== JSON.stringify(actual.migrations?.[id])) {
      throw new Error(`Native embeddable migrations differ for ${id}`);
    }
  }
  return native;
};
