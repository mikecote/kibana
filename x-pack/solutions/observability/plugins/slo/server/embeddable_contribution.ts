/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { registerOverviewEmbeddable } from './lib/embeddables/register_overview_embeddable';
import { registerErrorBudgetEmbeddable } from './lib/embeddables/register_error_budget_embeddable';
import { registerAlertsEmbeddable } from './lib/embeddables/register_alerts_embeddable';
import { registerBurnRateEmbeddable } from './lib/embeddables/register_burn_rate_embeddable';

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    registerOverviewEmbeddable(embeddable);
    registerErrorBudgetEmbeddable(embeddable);
    registerAlertsEmbeddable(embeddable);
    registerBurnRateEmbeddable(embeddable);
  },
};
