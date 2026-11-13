/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const REMOTABLE_INSTANCE = Symbol.for('kbn.remote.instance');

/** Marks a plain class for by-reference RPC results, without decorators or DI metadata. */
export const remotable = <T extends { prototype: object }>(target: T): T => {
  Object.defineProperty(target.prototype, REMOTABLE_INSTANCE, { value: true });
  return target;
};

export const isRemotableInstance = (value: unknown): value is object =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[REMOTABLE_INSTANCE] === true;
