/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { TaskTypeModule } from '../task_type_module';
import { TaskProcessAcquireError } from './acquire_error';

export type TaskFeatureFlagDefinitions = NonNullable<TaskTypeModule['featureFlags']>;

const declarationsSchema = schema.object({
  taskType: schema.string({ minLength: 1, maxLength: 1024 }),
  featureFlags: schema.recordOf(
    schema.string({ minLength: 1, maxLength: 256 }),
    schema.oneOf([schema.string({ maxLength: 4096 }), schema.number(), schema.boolean()]),
    {
      validate: (flags) =>
        Object.keys(flags).length > 1024 ? 'Too many task feature flag declarations' : undefined,
    }
  ),
});

/** Validates worker declarations without changing the types of feature flag defaults. */
export const parseTaskFeatureFlagDeclarations = (
  json: string,
  taskType: string
): TaskFeatureFlagDefinitions => {
  if (Buffer.byteLength(json) > 64 * 1024) {
    throw new TaskProcessAcquireError(
      'incompatible',
      'Task feature flag declarations are too large'
    );
  }
  try {
    const declarations = declarationsSchema.validate(JSON.parse(json));
    if (declarations.taskType !== taskType) {
      throw new TaskProcessAcquireError(
        'incompatible',
        'Task worker returned feature flag declarations for another task type'
      );
    }
    return declarations.featureFlags;
  } catch (error) {
    if (error instanceof TaskProcessAcquireError) throw error;
    throw new TaskProcessAcquireError('incompatible', 'Invalid task feature flag declarations');
  }
};

/** Refuses dispatch when Main did not evaluate every declared flag with its native value type. */
export const assertTaskFeatureFlagValues = (
  values: TaskFeatureFlagDefinitions | undefined,
  declarations: TaskFeatureFlagDefinitions
): void => {
  const missing = Object.entries(declarations).filter(
    ([name, fallback]) =>
      !values || !Object.hasOwn(values, name) || typeof values[name] !== typeof fallback
  );
  if (missing.length)
    throw new TaskProcessAcquireError(
      'incompatible',
      `Main did not evaluate native task feature flags: ${missing.map(([name]) => name).join(', ')}`
    );
};
