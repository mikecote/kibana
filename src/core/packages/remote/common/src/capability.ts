/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CapabilityToken } from './token';

export type CapabilityPlacement = 'executor' | 'coordinator';
export type CapabilityScope = 'worker' | 'run';
export type CapabilityDependencies<Tokens extends readonly CapabilityToken[]> = {
  readonly [Index in keyof Tokens]: Tokens[Index] extends CapabilityToken<infer Value>
    ? Value
    : never;
};

export interface CapabilityDefinition<Value extends object = object, Dependencies = never> {
  readonly token: CapabilityToken<Value>;
  readonly placement: CapabilityPlacement;
  readonly scope: CapabilityScope;
  readonly needs: readonly CapabilityToken[];
  readonly create: (dependencies: Dependencies) => Value;
}

/** Declares placement, lifetime and typed dependencies independently of the capability class. */
export const defineCapability = <
  Value extends object,
  const Needs extends readonly CapabilityToken[]
>(
  definition: CapabilityDefinition<Value, CapabilityDependencies<Needs>> & { readonly needs: Needs }
): CapabilityDefinition<Value, CapabilityDependencies<Needs>> => definition;
