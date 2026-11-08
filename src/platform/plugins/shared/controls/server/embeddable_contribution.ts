/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { registerESQLControlTransforms } from './transforms/esql_control_transforms';
import { registerOptionsListControlTransforms } from './transforms/options_list_control_transforms';
import { registerRangeSliderControlTransforms } from './transforms/range_slider_control_transforms';
import { registerTimeSliderControlTransforms } from './transforms/time_slider_control_transforms';

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    registerESQLControlTransforms(embeddable);
    registerOptionsListControlTransforms(embeddable);
    registerRangeSliderControlTransforms(embeddable);
    registerTimeSliderControlTransforms(embeddable);
  },
};
