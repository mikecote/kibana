/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Logger } from '@kbn/core/server';
import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { VEGA_EMBEDDABLE_TYPE, VEGA_STANDALONE_EMBEDDABLE_FLAG } from '../common/constants';
import { getVegaEmbeddableSchema } from './embeddable/schema';
import { getTransforms } from './embeddable/transforms';

/** Registers Vega's native schema and transforms with the current execution flag. */
export const registerVegaEmbeddable = (
  embeddable: EmbeddableSetup,
  isEnabled: () => boolean,
  logger?: Logger
): void => {
  embeddable.registerEmbeddableServerDefinition(VEGA_EMBEDDABLE_TYPE, {
    title: 'Vega',
    getTransforms: (drilldownTransforms) => getTransforms(drilldownTransforms, logger),
    getSchema: (getDrilldownsSchema) =>
      isEnabled() ? getVegaEmbeddableSchema(getDrilldownsSchema) : undefined,
  });
};

export const contribution: EmbeddableContribution = {
  declares: { featureFlags: { [VEGA_STANDALONE_EMBEDDABLE_FLAG]: false } },
  register: (embeddable, { featureFlags }) => {
    let enabled = false;
    featureFlags?.getBooleanValue$(VEGA_STANDALONE_EMBEDDABLE_FLAG, false).subscribe((value) => {
      enabled = value;
    });
    registerVegaEmbeddable(embeddable, () => enabled);
  },
};
