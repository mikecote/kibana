/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { SEARCH_EMBEDDABLE_TYPE } from '@kbn/discover-utils';
import { getDiscoverSessionEmbeddableSchema } from './embeddable/schema';
import { getSearchEmbeddableTransforms } from '../common/embeddable';

import { createSearchEmbeddableFactory } from './embeddable';

/** Registers the plugin's native embeddable definitions in Main and workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(SEARCH_EMBEDDABLE_TYPE, {
    title: 'Discover session',
    getTransforms: (drilldownTransforms) => getSearchEmbeddableTransforms(drilldownTransforms),
    getSchema: (getDrilldownsSchema) => getDiscoverSessionEmbeddableSchema(getDrilldownsSchema),
  });
};

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    embeddable.registerEmbeddableFactory(createSearchEmbeddableFactory());
    registerEmbeddableDefinitions(embeddable);
  },
};
