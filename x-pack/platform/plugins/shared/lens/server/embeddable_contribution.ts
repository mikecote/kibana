/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { LensConfigBuilder } from '@kbn/lens-embeddable-utils';
import { DataViewPersistableStateService } from '@kbn/data-views-plugin/common';
import { getAllMigrations } from '@kbn/data-plugin/common/query/filters/persistable_state';
import {
  createNativeVisualizationMigrations,
  LENS_MIGRATION_CONTRIBUTIONS_KEY,
  LENS_RUNTIME_SETTINGS_ID,
} from './visualization_migration_contribution';
import type {
  LensMigrationContribution,
  LensRuntimeSettings,
} from './visualization_migration_contribution';
import { registerLensEmbeddableFactory } from './register_lens_embeddable_factory';
import { makeLensEmbeddableFactory } from './embeddable/make_lens_embeddable_factory';
import { registerLensEmbeddableTransforms } from './transforms';
import { registerLensEmbeddableTransformsForDashboardApp } from './dashboard_app_transforms';
import { registerDiscoverDrilldown } from './drilldowns/register_discover_drilldown';

export const contribution: EmbeddableContribution = {
  declares: {
    featureFlags: { 'lens.apiFormat': false },
    contributionKeys: [LENS_MIGRATION_CONTRIBUTIONS_KEY],
    settings: [LENS_RUNTIME_SETTINGS_ID],
  },
  register: (embeddable, { featureFlags, settings, getContributions }) => {
    const snapshot = settings?.[LENS_RUNTIME_SETTINGS_ID] as LensRuntimeSettings | undefined;
    if (!snapshot) throw new Error('Native Lens migrations require Main registration metadata');
    const migrations = createNativeVisualizationMigrations(
      getContributions?.<LensMigrationContribution>(LENS_MIGRATION_CONTRIBUTIONS_KEY) ?? [],
      snapshot
    );
    registerLensEmbeddableFactory(
      embeddable,
      makeLensEmbeddableFactory(
        getAllMigrations,
        DataViewPersistableStateService.getAllMigrations,
        migrations
      )()
    );
    registerDiscoverDrilldown(embeddable);
    const builder = new LensConfigBuilder();
    featureFlags
      ?.getBooleanValue$('lens.apiFormat', false)
      .subscribe((enabled) => builder.setEnabled(enabled));
    registerLensEmbeddableTransforms(embeddable, builder);
    registerLensEmbeddableTransformsForDashboardApp(embeddable, builder);
  },
};
