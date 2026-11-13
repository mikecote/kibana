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
import { LINKS_EMBEDDABLE_TYPE } from '../common';
import { transforms } from '../common/embeddable/transforms/transforms';
import { linksEmbeddableSchema } from './api/schemas';

/** Registers the same native panel definitions in Main and task workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(LINKS_EMBEDDABLE_TYPE, {
    title: 'Links',
    getTransforms: () => transforms,
    getSchema: () => linksEmbeddableSchema,
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
