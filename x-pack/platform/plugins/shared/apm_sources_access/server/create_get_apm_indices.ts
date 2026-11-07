/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsClientContract } from '@kbn/core/server';
import type { APMIndices } from '../common/config_schema';
import { getApmIndicesSavedObject } from './saved_objects/apm_indices';

/** Resolves configured APM indices with the native space-aware saved-object overrides. */
export const createGetApmIndices =
  (
    getConfiguredIndices: () => APMIndices
  ): ((savedObjectsClient: SavedObjectsClientContract) => Promise<APMIndices>) =>
  async (savedObjectsClient) => {
    const overrides = await getApmIndicesSavedObject(savedObjectsClient);
    return { ...getConfiguredIndices(), ...overrides };
  };
