/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { fieldStatsTableEmbeddableSchema } from '@kbn/data-visualizer-server-schemas/embeddables/field_stats';
import { FIELD_STATS_EMBEDDABLE_TYPE } from '../common/embeddables/constants';
import { transformIn } from '../common/embeddables/transform_in';
import { transformOut } from '../common/embeddables/transform_out';

/** Registers the same native panel definitions in Main and task workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(FIELD_STATS_EMBEDDABLE_TYPE, {
    title: 'Field statistics table',
    getSchema: () => fieldStatsTableEmbeddableSchema,
    getTransforms: () => ({
      transformIn,
      transformOut,
    }),
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
