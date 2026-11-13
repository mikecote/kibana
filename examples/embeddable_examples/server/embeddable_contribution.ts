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
import { BOOK_EMBEDDABLE_TYPE } from '../common';
import { bookTransforms } from '../common/book/transforms';

/** Registers the example's native book transforms in Main and task workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(BOOK_EMBEDDABLE_TYPE, {
    title: 'Book',
    getTransforms: () => bookTransforms,
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
