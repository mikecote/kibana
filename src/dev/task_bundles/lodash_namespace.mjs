/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const namespaces = [new WeakMap(), new WeakMap()];

/** Memoizes esbuild's CommonJS namespace for Lodash while preserving its property getters. */
export const toESM = (module, isNodeMode = 0) => {
  const cache = namespaces[isNodeMode ? 1 : 0];
  const cached = cache.get(module);
  if (cached) return cached;
  const target = Object.create(Object.getPrototypeOf(module));
  if (isNodeMode || !module.__esModule) {
    Object.defineProperty(target, 'default', { value: module, enumerable: true });
  }
  for (const key of Object.getOwnPropertyNames(module)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(module, key);
    Object.defineProperty(target, key, {
      get: () => module[key],
      enumerable: !descriptor || descriptor.enumerable,
    });
  }
  cache.set(module, target);
  return target;
};
