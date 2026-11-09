/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { getTransforms as getStatsTransforms } from '../common/embeddables/stats_overview/get_transforms';
import { SYNTHETICS_STATS_OVERVIEW_EMBEDDABLE } from '../common/embeddables/stats_overview/constants';
import { getTransforms as getMonitorsTransforms } from '../common/embeddables/monitors_overview/get_transforms';
import { SYNTHETICS_MONITORS_EMBEDDABLE } from '../common/embeddables/monitors_overview/constants';
import { getStatsOverviewEmbeddableSchema, syntheticsMonitorsEmbeddableSchema } from './schemas';

/** Registers the same native panel definitions in Main and task workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  // Register transforms and schema for SYNTHETICS_STATS_OVERVIEW_EMBEDDABLE
  embeddable.registerEmbeddableServerDefinition(SYNTHETICS_STATS_OVERVIEW_EMBEDDABLE, {
    title: 'Synthetics stats overview',
    getTransforms: getStatsTransforms,
    getSchema: getStatsOverviewEmbeddableSchema,
  });

  // Register transforms and schema for SYNTHETICS_MONITORS_EMBEDDABLE
  embeddable.registerEmbeddableServerDefinition(SYNTHETICS_MONITORS_EMBEDDABLE, {
    title: 'Synthetics monitors',
    getTransforms: getMonitorsTransforms,
    getSchema: () => syntheticsMonitorsEmbeddableSchema,
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
