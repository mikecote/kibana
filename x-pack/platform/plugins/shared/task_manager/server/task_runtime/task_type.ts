/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ContainerModuleLoadOptions, Newable } from 'inversify';
import type { Type } from '@kbn/config-schema';
import type { ServiceToken } from '@kbn/core-di';
import type { CancellableTask, RunContext } from '../task';
import type { TaskRegisterDefinition } from '../task_type_dictionary';

/** Services a task type asks the host for: DI tokens, or classes the container builds. */
export type NeedsSpec = Record<string, ServiceToken<unknown> | Newable<unknown>>;

/** The resolved services, typed from the tokens that asked for them. */
export type ResolvedNeeds<N extends NeedsSpec> = {
  [K in keyof N]: N[K] extends Newable<infer T>
    ? T
    : N[K] extends ServiceToken<infer S>
    ? S
    : never;
};

/** The metadata Kibana registers with Task Manager: everything but the runner. */
export type TaskTypeDefinition = Omit<TaskRegisterDefinition, 'createTaskRunner'>;

/**
 * Binds tokens for the services a task type needs. A plugin's `server/task_runtime/module.ts`
 * exports one per service it offers to tasks. In Kibana the plugin binds the same tokens to its
 * live instances, so the task code is the same in both places.
 */
export interface ServiceModule {
  id: string;
  /** Loaded first; deduplicated by identity. */
  requires?: readonly ServiceModule[];
  /** Config this module reads, validated by the host at `path` in the process config. */
  config?: { path: string | string[]; schema: Type<unknown>; token: ServiceToken<unknown> };
  load: (options: ContainerModuleLoadOptions) => void;
}

export interface TaskTypeModule<N extends NeedsSpec = NeedsSpec> {
  /** The Task Manager task type, such as `alerting_v2:alert_actions_cleanup`. */
  type: string;
  definition: TaskTypeDefinition;
  needs: N;
  /** What a headless host loads to provide `needs`; Kibana ignores it. */
  modules?: readonly ServiceModule[];
  /** Whether the run needs the fake request Task Manager builds from the task's API key. */
  requiresFakeRequest?: boolean;
  createRunner(services: ResolvedNeeds<N>, context: RunContext): CancellableTask;
}

export const defineTaskType = <N extends NeedsSpec>(unit: TaskTypeModule<N>): TaskTypeModule<N> =>
  unit;

export const defineServiceModule = (module: ServiceModule): ServiceModule => module;
