/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IpcSession } from '@kbn/core-remote-server-internal';
import type { CoordinatorCapabilities } from './coordinator_capabilities';
import type { TaskProcessInit } from './wire';
import { digestValue, hydrateInventories } from './init_inventory';

/** Boot reads and lazy native registration checks dispose every temporary RPC handle. */
export const prepareWorkerInitialization = async (
  session: IpcSession<CoordinatorCapabilities>,
  init: TaskProcessInit
) => {
  const initialized = new Map<string, string>();
  const use = async <Result>(
    run: (api: Awaited<ReturnType<typeof session.remote.initialization>>) => Promise<Result>
  ): Promise<Result> => {
    const api = await session.remote.initialization();
    try {
      return await run(api);
    } finally {
      api[Symbol.dispose]();
    }
  };
  await use(async (api) => {
    const request = api.inventories();
    try {
      hydrateInventories(init, await request);
    } finally {
      request[Symbol.dispose]();
    }
  });
  return {
    readContent: (digest: string) =>
      use(async (api) => {
        const request = api.content(digest);
        try {
          return await request;
        } finally {
          request[Symbol.dispose]();
        }
      }),
    validateRegistrations: (ids: Record<string, string[]>) =>
      use(async (api) => {
        const normalized = Object.fromEntries(
          Object.entries(ids)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, values]) => [kind, [...values].sort()])
        );
        const group = Object.keys(normalized).sort().join(',');
        const digest = digestValue(normalized);
        // Runtime registration occurs after forRun acquisition and before any conditional progress.
        // A dedicated witness call therefore precedes business execution without eager runtime setup.
        const request = api.registrations(
          group,
          digest,
          initialized.get(group) === digest ? undefined : normalized
        );
        try {
          const gap = await request;
          initialized.set(group, digest);
          return gap;
        } finally {
          request[Symbol.dispose]();
        }
      }),
  };
};
