/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CustomVisualizationMigrations } from './migrations/types';

export const LENS_MIGRATION_CONTRIBUTIONS_KEY = 'lens-visualization-migrations';
export const LENS_RUNTIME_SETTINGS_ID = 'lensRuntime';

export interface LensMigrationContribution {
  migrations: CustomVisualizationMigrations;
}

export interface LensRuntimeSettings {
  visualizationMigrations: Record<string, string[]>;
}

/** Captures migration inventories from the visualization registrations active in Main. */
export const getLensRuntimeSettings = (
  migrations: CustomVisualizationMigrations
): LensRuntimeSettings => ({
  visualizationMigrations: Object.fromEntries(
    Object.entries(migrations).map(([id, getMigrations]) => [
      id,
      Object.keys(getMigrations()).sort(),
    ])
  ),
});

/** Restores actual custom visualization migrations and verifies Main's enabled inventory. */
export const createNativeVisualizationMigrations = (
  contributions: readonly LensMigrationContribution[],
  expected: LensRuntimeSettings
): CustomVisualizationMigrations => {
  const candidates = new Map<string, CustomVisualizationMigrations[string]>();
  for (const { migrations } of contributions) {
    for (const [id, getMigrations] of Object.entries(migrations)) {
      if (candidates.has(id))
        throw new Error(`Migrations object for visualization ${id} registered already`);
      candidates.set(id, getMigrations);
    }
  }
  const restored: CustomVisualizationMigrations = {};
  for (const [id, versions] of Object.entries(expected.visualizationMigrations)) {
    const getMigrations = candidates.get(id);
    if (!getMigrations) throw new Error(`Missing native Lens visualization migrations for ${id}`);
    if (
      JSON.stringify([...versions].sort()) !== JSON.stringify(Object.keys(getMigrations()).sort())
    )
      throw new Error(`Native Lens visualization migrations differ for ${id}`);
    restored[id] = getMigrations;
  }
  return restored;
};
