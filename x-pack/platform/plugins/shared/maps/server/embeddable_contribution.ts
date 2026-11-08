/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { DataViewPersistableStateService } from '@kbn/data-views-plugin/common';
import { getAllMigrations } from '@kbn/data-plugin/common/query/filters/persistable_state';
import { MAP_SAVED_OBJECT_TYPE } from '../common/constants';
import { getTransforms } from '../common/embeddable/transforms/get_transforms';

import { setupEmbeddable } from './embeddable';

/** Registers the plugin's native embeddable definitions in Main and workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(MAP_SAVED_OBJECT_TYPE, {
    title: 'Map',
    getTransforms,
  });
};

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    setupEmbeddable(embeddable, getAllMigrations, DataViewPersistableStateService.getAllMigrations);
    registerEmbeddableDefinitions(embeddable);
  },
};
