/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createToken, defineCapability, remoteTokenId } from '@kbn/core-remote-common';
import type { CapabilityDefinition } from '@kbn/core-remote-common';
import { composeCapabilities } from '@kbn/core-remote-server-internal';
import type { CoordinatorRequestFactory } from './coordinator_request';
import { CoordinatorRequestToken } from './coordinator_request';
import { TaskPoolApi } from './task_pool_api';
import { RunProgressApi } from './run_progress_api';
import { InitializationApi } from './initialization_api';
import type { InitializationSource } from './initialization_api';
import { RunCoordinator } from './run_coordinator';

export interface CoordinatorPlacement {
  manifest: readonly CapabilityDefinition[];
  requests: CoordinatorRequestFactory;
}

export interface CoordinatorCallbacks {
  getCurrentTasksInPool?: () => Promise<readonly string[]> | readonly string[];
  reportProgress: (createdTaskCount: number) => void;
}

export const TaskPoolToken = createToken<TaskPoolApi>('taskManager.TaskPoolApi');
export const RunProgressToken = createToken<RunProgressApi>('taskManager.RunProgressApi');
const InitializationToken = createToken<InitializationApi>('taskManager.InitializationApi');
const RunCoordinatorToken = createToken<RunCoordinator>('taskManager.RunCoordinator');

/** Exposes only the coordinator callbacks owned by a currently leased execution. */
export class CoordinatorCapabilities {
  private readonly initializationApi?: InitializationApi;
  constructor(
    private readonly getRun: (executionUuid: string) => CoordinatorCallbacks | undefined,
    initialization?: InitializationSource,
    private readonly placement?: CoordinatorPlacement
  ) {
    if (initialization)
      this.initializationApi = composeCapabilities(
        [
          defineCapability({
            token: InitializationToken,
            placement: 'coordinator',
            scope: 'worker',
            needs: [] as const,
            create: () => new InitializationApi(initialization),
          }),
        ],
        'coordinator'
      ).worker.get(InitializationToken);
  }

  initialization(): InitializationApi {
    if (!this.initializationApi) throw new Error('No local initialization authority');
    return this.initializationApi;
  }

  assertRegistrations(): void {
    this.initializationApi?.assertCurrent();
  }

  forRun(executionUuid: string): RunCoordinator {
    const active = (): CoordinatorCallbacks => {
      const callbacks = this.getRun(executionUuid);
      if (!callbacks) throw new Error(`No leased task execution: ${executionUuid}`);
      return callbacks;
    };
    active();
    const manifest: CapabilityDefinition[] = [
      defineCapability({
        token: CoordinatorRequestToken,
        placement: 'coordinator',
        scope: 'run',
        needs: [] as const,
        create: () => ({
          create: (identity) => {
            active();
            if (!this.placement) throw new Error('No coordinator request factory');
            return this.placement.requests.create(identity);
          },
        }),
      }),
      ...(this.placement?.manifest ?? []),
      defineCapability({
        token: TaskPoolToken,
        placement: 'coordinator',
        scope: 'run',
        needs: [] as const,
        create: () =>
          new TaskPoolApi(async () => {
            const getPool = active().getCurrentTasksInPool;
            if (!getPool) throw new Error('Dispatching Task Manager has no active-pool provider');
            return getPool();
          }),
      }),
      defineCapability({
        token: RunProgressToken,
        placement: 'coordinator',
        scope: 'run',
        needs: [] as const,
        create: () =>
          new RunProgressApi((createdTaskCount) => active().reportProgress(createdTaskCount)),
      }),
      defineCapability({
        token: RunCoordinatorToken,
        placement: 'coordinator',
        scope: 'run',
        needs: [TaskPoolToken, RunProgressToken] as const,
        create: ([pool, progress]): RunCoordinator =>
          new RunCoordinator(pool, progress, (tokenId) => {
            active();
            const definition = this.placement?.manifest.find(
              ({ token }) => remoteTokenId(token) === tokenId
            );
            if (!definition) throw new Error(`Undeclared coordinator capability: ${tokenId}`);
            return run.get(definition.token);
          }),
      }),
    ];
    const run = composeCapabilities(manifest, 'coordinator').createRun();
    return run.get(RunCoordinatorToken);
  }
}
