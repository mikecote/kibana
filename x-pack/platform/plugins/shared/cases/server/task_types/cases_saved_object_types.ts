/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger, SavedObjectsType } from '@kbn/core/server';
import { filesRunSavedObjectTypes } from '@kbn/files-plugin/server';
import type { LensServerPluginSetup } from '@kbn/lens-plugin/server';
import { extract, inject } from '@kbn/lens-plugin/server/embeddable/references';
import { SpacesSavedObjectMappings } from '@kbn/spaces-plugin/server/saved_objects/mappings';
import { ConfigSchema } from '../config';
import { registerSavedObjects } from '../saved_object_types';

/**
 * The lens embeddable factory of a task process. A comment is saved with the references that
 * `extract` finds in its lens visualizations; the migrations of the saved object types are Kibana's
 * (a process skips them), so none are given.
 */
export const taskProcessLensEmbeddableFactory: LensServerPluginSetup['lensEmbeddableFactory'] =
  () => ({
    id: 'lens',
    migrations: () => ({}),
    extract,
    inject,
  });

const noopLogger: Logger = new Proxy({} as Logger, {
  get: (_target, property) => (property === 'get' ? () => noopLogger : () => {}),
});

/**
 * The saved object types a run of the cases steps registers with Core, from the code that registers
 * them in `setup()` (with a collecting registrar), plus the `space` type: the disabled features of
 * a space decide which cases owners a user can reach.
 */
export const getCasesTaskProcessSavedObjectTypes = (): SavedObjectsType[] => {
  const types: SavedObjectsType[] = [...filesRunSavedObjectTypes];
  registerSavedObjects({
    core: {
      savedObjects: { registerType: (type: SavedObjectsType) => types.push(type) },
      getStartServices: () => Promise.reject(new Error('Not available in a task process')),
    } as unknown as CoreSetup,
    logger: noopLogger,
    lensEmbeddableFactory: taskProcessLensEmbeddableFactory,
    config: ConfigSchema.validate({}),
  });
  types.push({
    name: 'space',
    hidden: true,
    namespaceType: 'agnostic',
    mappings: SpacesSavedObjectMappings,
  } as SavedObjectsType);
  return types;
};
