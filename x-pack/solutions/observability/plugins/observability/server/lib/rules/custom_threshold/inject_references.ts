/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { injectReferences } from '@kbn/data-plugin/common';
import type { SavedObjectReference } from '@kbn/core/server';

/** Restores the saved search configuration referenced by a custom threshold rule. */
export const injectCustomThresholdReferences = <
  Params extends { searchConfiguration: Parameters<typeof injectReferences>[0] }
>(
  params: Params,
  references: SavedObjectReference[]
): Omit<Params, 'searchConfiguration'> & {
  searchConfiguration: ReturnType<typeof injectReferences>;
} => ({
  ...params,
  searchConfiguration: injectReferences(params.searchConfiguration, references),
});
