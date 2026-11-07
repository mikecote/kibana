/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ApiKeyType } from './api_key_strategy';
import type {
  TaskSchedulingDefinition,
  TaskSchedulingDefinitionRegistry,
  TaskSchedulingRegistration,
} from './task_scheduling_definition_registry';
import { sanitizeTaskSchedulingDefinitions } from './task_scheduling_definition_registry';

export type NativeTaskSchedulingSchemas = Pick<
  TaskSchedulingRegistration,
  'paramsSchema' | 'stateSchemaByVersion'
>;

export interface TaskSchedulingDefinitionSnapshot {
  definition: Omit<TaskSchedulingDefinition, 'paramsSchema' | 'stateSchemaByVersion'>;
  paramsSchemaRequired: boolean;
  stateSchemaVersions: number[];
}

export interface TaskManagerTaskProcessSettings {
  api_key_type: ApiKeyType;
  grant_uiam_api_keys: boolean;
  scheduling: {
    taskManagerId: string;
    securityEnabled: boolean;
    allowReadingInvalidState: boolean;
    definitions: TaskSchedulingDefinitionSnapshot[];
    claimNudge?: { index: string };
  };
}

/** Captures native scheduling metadata while keeping schema classes and migrations in their owning modules. */
export const createTaskSchedulingSnapshot = (
  registry: TaskSchedulingDefinitionRegistry
): TaskSchedulingDefinitionSnapshot[] => {
  const definitions: Record<string, TaskSchedulingRegistration> = {};
  for (const type of registry.getAllTypes()) {
    const definition = registry.get(type);
    if (!definition)
      throw new Error(`Native task scheduling definition "${type}" is not registered`);
    definitions[type] = definition;
  }
  return sanitizeTaskSchedulingDefinitions(definitions).map(
    ({ paramsSchema, stateSchemaByVersion, ...definition }) => ({
      definition,
      paramsSchemaRequired: paramsSchema !== undefined,
      stateSchemaVersions: Object.keys(stateSchemaByVersion ?? {})
        .map(Number)
        .sort((left, right) => left - right),
    })
  );
};
