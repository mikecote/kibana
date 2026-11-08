/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { registerEmbeddables } from './lib/register_embeddables';

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    registerEmbeddables(embeddable, { ad: true, dfa: false, nlp: false });
  },
};
