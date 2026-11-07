/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { validateTaskDefinitionRegistrations } from './task_type_dictionary';
import type { TaskDefinition } from './task';
import { taskDefinitionSchema, taskRunAsWorkloadTypesSchema } from './task';
import type {
  NativeTaskSchedulingSchemas,
  TaskSchedulingDefinitionSnapshot,
} from './task_scheduling_snapshot';
import type { TaskRegisterDefinition } from './task_type_dictionary';

const schedulingDefinitionSchema = taskDefinitionSchema.extends(
  {
    observeRemoteRun: null,
    runAs: schema.maybe(
      schema.object({ workloadTypes: taskRunAsWorkloadTypesSchema }, { unknowns: 'ignore' })
    ),
  },
  { unknowns: 'ignore' }
);

export type TaskSchedulingDefinition = Omit<
  TaskDefinition,
  'createTaskRunner' | 'observeRemoteRun' | 'runAs'
> & { runAs?: Pick<NonNullable<TaskDefinition['runAs']>, 'workloadTypes'> };

export type TaskSchedulingRegistration = Omit<
  TaskRegisterDefinition,
  'createTaskRunner' | 'observeRemoteRun' | 'runAs'
> & { runAs?: Pick<NonNullable<TaskDefinition['runAs']>, 'workloadTypes'> };

/** The task definition metadata consumed by native storage, validation and scheduling. */
export interface TaskSchedulingDefinitionRegistry {
  get(type: string): TaskSchedulingDefinition | undefined;
  has(type: string): boolean;
  ensureHas(type: string): void;
  getAllDefinitions(): TaskSchedulingDefinition[];
  getAllTypes(): string[];
  size(): number;
}

/** Holds native task metadata without inventing runners for tasks that another process executes. */
export class TaskSchedulingDefinitions implements TaskSchedulingDefinitionRegistry {
  private readonly definitions = new Map<string, TaskSchedulingDefinition>();
  private readonly missingSchemas = new Set<string>();

  constructor(
    snapshots: readonly TaskSchedulingDefinitionSnapshot[] = [],
    nativeSchemas: Readonly<Record<string, NativeTaskSchedulingSchemas>> = {}
  ) {
    for (const snapshot of snapshots) {
      const { definition, paramsSchemaRequired, stateSchemaVersions } = snapshot;
      const schemas = nativeSchemas[definition.type];
      const availableStateVersions = Object.keys(schemas?.stateSchemaByVersion ?? {})
        .map(Number)
        .sort((left, right) => left - right);
      if (
        paramsSchemaRequired !== (schemas?.paramsSchema !== undefined) ||
        stateSchemaVersions.length !== availableStateVersions.length ||
        stateSchemaVersions.some((version, index) => version !== availableStateVersions[index])
      )
        this.missingSchemas.add(definition.type);
      this.registerTaskDefinitions({ [definition.type]: { ...definition, ...schemas } });
    }
  }

  public registerTaskDefinitions(
    definitions: Readonly<Record<string, TaskSchedulingRegistration>>
  ): void {
    validateTaskDefinitionRegistrations(
      { has: (type) => this.has(type), get: (type) => this.definitions.get(type) },
      definitions
    );
    const validated = sanitizeTaskSchedulingDefinitions(definitions);
    for (const definition of validated) this.definitions.set(definition.type, definition);
  }

  public has(type: string): boolean {
    return this.definitions.has(type);
  }

  public get(type: string): TaskSchedulingDefinition | undefined {
    if (this.missingSchemas.has(type))
      throw new Error(`Native scheduling schemas are not available for task type "${type}"`);
    return this.definitions.get(type);
  }

  public getAllTypes(): string[] {
    return [...this.definitions.keys()];
  }

  public getAllDefinitions(): TaskSchedulingDefinition[] {
    return [...this.definitions.values()];
  }

  public size(): number {
    return this.definitions.size;
  }

  public ensureHas(type: string): void {
    this.get(type);
    if (!this.definitions.has(type)) {
      throw new Error(
        `Unsupported task type "${type}". Supported types are ${this.getAllTypes().join(', ')}`
      );
    }
  }
}

/** Applies the native registration schema while dropping execution-only properties. */
export const sanitizeTaskSchedulingDefinitions = (
  definitions: Readonly<Record<string, TaskSchedulingRegistration>>
): TaskSchedulingDefinition[] =>
  Object.entries(definitions).map(
    ([type, definition]) =>
      schedulingDefinitionSchema.validate({ type, ...definition }) as TaskSchedulingDefinition
  );
