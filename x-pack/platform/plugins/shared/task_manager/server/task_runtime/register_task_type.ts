/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Container } from 'inversify';
import type { CancellableTask, RunContext } from '../task';
import type { TaskManagerSetupContract } from '../plugin';
import { createRunnerInScope } from './resolve_needs';
import type { NeedsSpec, ResolvedNeeds, TaskTypeDefinition, TaskTypeModule } from './task_type';

/** Where Kibana's in-process runs get the services a task type needs. */
export type ServicesProvider<N extends NeedsSpec> =
  | {
      /** Plain plugins: build the services from what the plugin already has. */
      resolve: (context: RunContext) => Promise<ResolvedNeeds<N>> | ResolvedNeeds<N>;
    }
  | {
      /** DI plugins: resolve the needs from the plugin's container, forked per run. */
      container: () => Container | Promise<Container>;
    };

/**
 * Registers a task type with Task Manager from its module. Kibana claims, validates and reschedules
 * as for any task type; the runner is the module's, fed from the plugin's own services. A task
 * process that serves the type runs the same module with services built by a headless host.
 */
export const registerTaskType = <N extends NeedsSpec>(
  taskManager: Pick<TaskManagerSetupContract, 'registerTaskDefinitions'>,
  unit: TaskTypeModule<N>,
  provider: ServicesProvider<N>,
  overrides: Partial<TaskTypeDefinition> = {}
): void => {
  taskManager.registerTaskDefinitions({
    [unit.type]: {
      ...unit.definition,
      ...overrides,
      createTaskRunner: (context: RunContext): CancellableTask => {
        let created: CancellableTask | undefined;
        let cancelled = false;
        const create = async (): Promise<CancellableTask> => {
          if ('container' in provider) {
            return createRunnerInScope(unit, await provider.container(), context);
          }
          if ((unit.requiresFakeRequest ?? true) && !context.fakeRequest) {
            throw new Error(
              `Cannot execute ${unit.type} task without Task Manager fakeRequest. Ensure the task is scheduled with an API key (task id: ${context.taskInstance.id})`
            );
          }
          return unit.createRunner(await provider.resolve(context), context);
        };
        return {
          run: async () => {
            created = await create();
            if (cancelled) await created.cancel?.();
            return created.run();
          },
          cancel: async () => {
            cancelled = true;
            await created?.cancel?.();
          },
        };
      },
    },
  });
};
