/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Middleware } from './lib/middleware';
import { addMiddlewareToChain, createInitialMiddleware } from './lib/middleware';
import type { TaskHost } from './task_type_module';
import type { TaskSchedulingContribution } from './task_scheduling_contribution';

/** Builds the native scheduling chain in Main's registration order after validating every provider. */
export const createTaskSchedulingMiddleware = (
  ids: readonly string[],
  contributions: readonly TaskSchedulingContribution[],
  settings: NonNullable<TaskHost['settings']>
): Middleware => {
  if (!Array.isArray(ids))
    throw new Error('Native scheduling requires the registered middleware ids');
  const providers = new Map<
    string,
    NonNullable<TaskSchedulingContribution['middleware']>[number]
  >();
  for (const contribution of contributions) {
    for (const provider of contribution.middleware ?? []) {
      if (providers.has(provider.id))
        throw new Error(`Duplicate native scheduling middleware provider ${provider.id}`);
      providers.set(provider.id, provider);
    }
  }
  const seen = new Set<string>();
  const ordered = ids.map((id) => {
    if (seen.has(id)) throw new Error(`Duplicate registered scheduling middleware ${id}`);
    seen.add(id);
    const provider = providers.get(id);
    if (!provider) throw new Error(`Native scheduling middleware is not available for ${id}`);
    return provider;
  });
  return ordered.reduce(
    (chain, provider) => addMiddlewareToChain(chain, provider.create(settings)),
    createInitialMiddleware()
  );
};
