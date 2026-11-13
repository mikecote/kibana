/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  CapabilityDefinition,
  CapabilityPlacement,
  CapabilityToken,
} from '@kbn/core-remote-common';
import { remoteTokenId } from '@kbn/core-remote-common';

export interface CapabilityResolver {
  get<Value extends object>(token: CapabilityToken<Value>): Value;
}

export interface CapabilityComposition {
  readonly worker: CapabilityResolver;
  createRun(): CapabilityResolver;
}

/** Composes one placement in dependency order, sharing worker instances across isolated run scopes. */
export const composeCapabilities = (
  manifest: readonly CapabilityDefinition[],
  placement: CapabilityPlacement,
  imports: ReadonlyMap<CapabilityToken, object> = new Map()
): CapabilityComposition => {
  const definitions = new Map<CapabilityToken, CapabilityDefinition>();
  for (const definition of manifest) {
    if (definitions.has(definition.token)) {
      throw new Error(`Duplicate capability: ${remoteTokenId(definition.token)}`);
    }
    definitions.set(definition.token, definition);
  }
  const ordered: CapabilityDefinition[] = [];
  const visiting = new Set<CapabilityToken>();
  const visited = new Set<CapabilityToken>();
  const visit = (token: CapabilityToken): void => {
    if (visited.has(token)) return;
    if (visiting.has(token)) throw new Error(`Capability cycle: ${remoteTokenId(token)}`);
    const definition = definitions.get(token);
    if (!definition || definition.placement !== placement) {
      if (!imports.has(token)) throw new Error(`Missing capability: ${remoteTokenId(token)}`);
      return;
    }
    visiting.add(token);
    for (const dependency of definition.needs) {
      const dependencyDefinition = definitions.get(dependency);
      if (definition.scope === 'worker' && dependencyDefinition?.scope === 'run') {
        throw new Error(`Worker capability cannot depend on run scope: ${remoteTokenId(token)}`);
      }
      visit(dependency);
    }
    visiting.delete(token);
    visited.add(token);
    ordered.push(definition);
  };
  for (const definition of definitions.values()) {
    if (definition.placement === placement) visit(definition.token);
  }
  const resolver = (instances: ReadonlyMap<CapabilityToken, object>): CapabilityResolver => ({
    get: <Value extends object>(token: CapabilityToken<Value>): Value => {
      const instance = instances.get(token);
      if (!instance)
        throw new Error(`Unavailable capability in this scope: ${remoteTokenId(token)}`);
      return instance as Value;
    },
  });
  const workers = new Map(imports);
  const construct = (definition: CapabilityDefinition, instances: Map<CapabilityToken, object>) => {
    const dependencies = definition.needs.map((token) => resolver(instances).get(token));
    // Heterogeneous factories are erased in the manifest; defineCapability checks their tuple types.
    instances.set(definition.token, definition.create(dependencies as never));
  };
  for (const definition of ordered) {
    if (definition.scope === 'worker') construct(definition, workers);
  }
  return {
    worker: resolver(workers),
    createRun: () => {
      const instances = new Map(workers);
      for (const definition of ordered) {
        if (definition.scope === 'run') construct(definition, instances);
      }
      return resolver(instances);
    },
  };
};
