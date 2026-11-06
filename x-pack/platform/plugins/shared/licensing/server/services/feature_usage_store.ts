/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { ISavedObjectsRepository, Logger, SavedObjectsType } from '@kbn/core/server';

/** The saved object that holds when a licensed feature was last used, one per feature. */
export const FEATURE_USAGE_SAVED_OBJECT_TYPE = 'licensing-feature-usage';

interface FeatureUsageAttributes {
  lastUsed: string;
}

export const featureUsageSavedObjectType: SavedObjectsType<FeatureUsageAttributes> = {
  name: FEATURE_USAGE_SAVED_OBJECT_TYPE,
  hidden: true,
  hiddenFromHttpApis: true,
  // A feature is used by the cluster, not by a space.
  namespaceType: 'agnostic',
  mappings: {
    dynamic: false,
    properties: {
      lastUsed: { type: 'date' },
    },
  },
  modelVersions: {
    1: {
      changes: [],
      schemas: {
        create: schema.object({ lastUsed: schema.string() }),
      },
    },
  },
};

const MAX_FEATURES = 1000;

/**
 * When licensed features were last used, kept in a saved object shared by every node and every task
 * process of the cluster, so what a process does is there for the next reader whichever it is.
 * Usages are coalesced in memory and written by `flush`, once per feature, so a feature used by many
 * runs does not write on every one of them.
 */
export class FeatureUsageStore {
  private pending = new Map<string, Date>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: Pick<ISavedObjectsRepository, 'update' | 'find'>,
    private readonly logger: Logger
  ) {}

  /** Keeps the latest time a feature was used until the next `flush`. */
  public record(featureId: string, usedAt: Date) {
    const recorded = this.pending.get(featureId);
    if (!recorded || usedAt > recorded) this.pending.set(featureId, usedAt);
  }

  /** Writes what was recorded and waits for it, also for a flush that is already writing. */
  public flush(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    const written = this.writing.then(() => this.write(batch));
    this.writing = written;
    return written;
  }

  private async write(batch: Map<string, Date>) {
    await Promise.all(
      [...batch].map(async ([featureId, usedAt]) => {
        try {
          const lastUsed = usedAt.toISOString();
          await this.repository.update(
            FEATURE_USAGE_SAVED_OBJECT_TYPE,
            featureId,
            { lastUsed },
            { upsert: { lastUsed } }
          );
        } catch (error) {
          // A usage that cannot be stored is not worth failing what used the feature for.
          this.logger.warn(`Failed to store the usage of feature '${featureId}': ${error.message}`);
          // Try again with the next flush, unless it was used again since.
          this.record(featureId, usedAt);
        }
      })
    );
  }

  /** When each feature that was stored was last used, by feature id. */
  public async read(): Promise<Map<string, Date>> {
    const { saved_objects: objects } = await this.repository.find<FeatureUsageAttributes>({
      type: FEATURE_USAGE_SAVED_OBJECT_TYPE,
      perPage: MAX_FEATURES,
    });
    return new Map(objects.map((object) => [object.id, new Date(object.attributes.lastUsed)]));
  }
}
