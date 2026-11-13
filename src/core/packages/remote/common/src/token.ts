/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export type CapabilityToken<T extends object = object> = symbol & { readonly _type?: T };

/** Creates a typed capability identity shared by coordinator and executor manifests. */
export const createToken = <T extends object>(id: string): CapabilityToken<T> => {
  if (!id) throw new Error('Capability tokens require a namespaced identity');
  return Symbol.for(id) as CapabilityToken<T>;
};

export const remoteTokenId = (token: CapabilityToken): string => {
  const id = Symbol.keyFor(token);
  if (!id) throw new Error('Remote capability tokens must be created with createToken()');
  return id;
};
