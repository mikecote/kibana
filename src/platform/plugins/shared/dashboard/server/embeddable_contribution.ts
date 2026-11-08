/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { dashboardPersistableStateServiceFactory } from './dashboard_container/dashboard_container_embeddable_factory';
import { registerDashboardDrilldown } from './dashboard_drilldown/register_dashboard_drilldown';

export const contribution: EmbeddableContribution = {
  register: (embeddable) => {
    embeddable.registerEmbeddableFactory(dashboardPersistableStateServiceFactory(embeddable));
    registerDashboardDrilldown(embeddable);
  },
};
