/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { REPO_ROOT } from '@kbn/repo-info';
import { coreMock } from '@kbn/core/server/mocks';
import { createEmbeddableServices } from '../create_embeddable_services';
import type { EmbeddableContribution } from './embeddable_contribution';

/** Captures complete test dispatch metadata from the owning embeddable registrars. */
export const createEmbeddableExampleSettings = (): Record<string, object> => {
  const { getContributionFiles } = jest.requireActual<{
    getContributionFiles: (key: string) => string[];
  }>(join(REPO_ROOT, 'src/dev/task_bundles/build'));
  const getContributions = <T extends object>(key: string): readonly T[] =>
    getContributionFiles(key).map(
      (file) => jest.requireActual<{ contribution: T }>(file).contribution
    );
  const migrations = getContributions<{
    migrations: Record<string, () => object>;
  }>('lens-visualization-migrations');
  const settings = {
    lensRuntime: {
      visualizationMigrations: Object.fromEntries(
        migrations.flatMap(({ migrations: visualizationMigrations }) =>
          Object.entries(visualizationMigrations).map(([id, getMigrations]) => [
            id,
            Object.keys(getMigrations()).sort(),
          ])
        )
      ),
    },
  };
  const main = createEmbeddableServices();
  for (const contribution of getContributions<EmbeddableContribution>('embeddables')) {
    contribution.register(main.setup, {
      settings,
      getContributions,
      featureFlags: coreMock.createStart().featureFlags,
    });
  }
  return { ...settings, embeddableRuntime: main.getRegistrationIds() };
};
