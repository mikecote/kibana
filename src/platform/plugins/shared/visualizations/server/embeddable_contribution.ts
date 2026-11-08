/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { VISUALIZE_EMBEDDABLE_TYPE } from '@kbn/visualizations-common';
import { SearchSourceService } from '@kbn/data-plugin/common/search/search_source/search_source_service';
import { makeVisualizeEmbeddableFactory } from './embeddable/make_visualize_embeddable_factory';
import { getTransforms } from '../common/embeddable/transforms/get_transforms';

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    const { getAllMigrations } = new SearchSourceService().setup();
    embeddable.registerEmbeddableFactory(makeVisualizeEmbeddableFactory(getAllMigrations)());
    embeddable.registerEmbeddableServerDefinition(VISUALIZE_EMBEDDABLE_TYPE, {
      title: 'Legacy visualization',
      getTransforms,
    });
  },
};
