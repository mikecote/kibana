/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { remoteTokenId } from '@kbn/core-remote-common';
import type { CapabilityToken, RemoteCapability } from '@kbn/core-remote-common';
import type { IpcSession } from '@kbn/core-remote-server-internal';
import type { TaskHost } from '../task_type_module';
import type { CoordinatorCapabilities } from './coordinator_capabilities';
import type { AdHocTaskCounter } from '../lib/adhoc_task_counter';

export interface WorkerRunControl {
  withCoordinatorCapability?: TaskHost['withCoordinatorCapability'];
  getCurrentTasksInPool(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

/** Pushes changed progress and reads the dispatching pool without a polling HTTP exchange. */
export const openWorkerRunControl = async (
  session: IpcSession<CoordinatorCapabilities>,
  executionUuid: string,
  counter: AdHocTaskCounter,
  signal: AbortSignal
): Promise<WorkerRunControl> => {
  const coordinator = await session.remote.forRun(executionUuid);
  const capabilities = new Map<string, Promise<object & Disposable>>();
  let publishedCount = counter.count;
  let pending: Promise<void> | undefined;
  const bounded = async <Result>(
    operation: PromiseLike<Result> & Disposable,
    timeoutMs: number
  ): Promise<Result> => {
    const completed = new AbortController();
    try {
      signal.throwIfAborted();
      return await Promise.race([
        operation,
        delay(timeoutMs, undefined, {
          signal: AbortSignal.any([signal, completed.signal]),
          ref: false,
        }).then(() => {
          throw new Error('Task process control request timed out');
        }),
      ]);
    } finally {
      completed.abort();
      operation[Symbol.dispose]();
    }
  };
  const publish = async (): Promise<void> => {
    const count = counter.count;
    if (count === publishedCount) return;
    await bounded(coordinator.reportProgress(count), 1000);
    publishedCount = count;
  };
  const timer = setInterval(() => {
    if (pending) return;
    pending = publish()
      .catch(() => {
        // Progress is best effort; the final native run response reconciles counts and metrics.
      })
      .finally(() => {
        pending = undefined;
      });
  }, 1000);
  timer.unref?.();
  return {
    withCoordinatorCapability: async <Capability extends object, Result>(
      token: CapabilityToken<Capability>,
      use: (capability: RemoteCapability<Capability>) => Promise<Result>
    ): Promise<Result> => {
      const id = remoteTokenId(token);
      let capability = capabilities.get(id);
      if (!capability) {
        capability = (async () => {
          const request = coordinator.capability(id);
          try {
            return (await request.dup()) as object & Disposable;
          } finally {
            request[Symbol.dispose]();
          }
        })();
        capabilities.set(id, capability);
      }
      return use((await capability) as RemoteCapability<Capability>);
    },
    getCurrentTasksInPool: async () => [
      ...(await bounded(coordinator.getCurrentTasksInPool(), 5000)),
    ],
    dispose: async () => {
      clearInterval(timer);
      await pending;
      for (const capability of capabilities.values()) {
        const stub = await capability.catch(() => undefined);
        stub?.[Symbol.dispose]();
      }
      coordinator[Symbol.dispose]();
    },
  };
};
