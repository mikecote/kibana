/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isDate } from 'lodash';
import type { Logger } from '@kbn/core/server';
import type { LicenseType } from '@kbn/licensing-types';
import type { FeatureUsageStore } from './feature_usage_store';

/** @public */
export interface FeatureUsageServiceSetup {
  /**
   * Register a feature to be able to notify of it's usages using the {@link FeatureUsageServiceStart | service start contract}.
   */
  register(featureId: string, licenseType: LicenseType): void;
}

export interface LastFeatureUsage {
  id: string;
  lastUsed: Date | null;
  licenseType: LicenseType;
}

/** @public */
export interface FeatureUsageServiceStart {
  /**
   * Notify of a registered feature usage at given time.
   *
   * @param featureId - the identifer of the feature to notify usage of
   * @param usedAt - Either a `Date` or an unix timestamp with ms. If not specified, it will be set to the current time.
   */
  notifyUsage(featureId: string, usedAt?: Date | number): void;
  /**
   * Returns the last usage timestamp of every registered feature, whichever node or task process
   * used it: what was stored by all of them, merged with what this node used and did not store yet.
   * Features that were not used yet have a `lastUsed` of `null`.
   */
  getLastUsages(): Promise<LastFeatureUsage[]>;
}

export class FeatureUsageService {
  private readonly lastUsages = new Map<string, LastFeatureUsage>();
  private store?: FeatureUsageStore;
  private flushTimer?: NodeJS.Timeout;

  public setup(): FeatureUsageServiceSetup {
    return {
      register: (featureId, licenseType) => {
        const registered = this.lastUsages.get(featureId);
        if (registered) {
          if (registered.licenseType !== licenseType) {
            throw new Error(
              `Feature '${featureId}' has already been registered with another license type. (current: ${registered.licenseType}, new: ${licenseType})`
            );
          }
        } else {
          this.lastUsages.set(featureId, {
            id: featureId,
            lastUsed: null,
            licenseType,
          });
        }
      },
    };
  }

  /**
   * @param options.store where usages are kept for every node and process to see; without it they
   * are kept in this node's memory, as before.
   * @param options.flushIntervalMs how often the usages of this node reach the store.
   */
  public start({
    store,
    flushIntervalMs = 10_000,
    logger,
  }: {
    store?: FeatureUsageStore;
    flushIntervalMs?: number;
    logger?: Logger;
  } = {}): FeatureUsageServiceStart {
    this.store = store;
    if (store) {
      this.flushTimer = setInterval(() => {
        store.flush().catch((error) => logger?.warn(`Failed to flush feature usages: ${error}`));
      }, flushIntervalMs);
      // The timer must not keep a process alive.
      this.flushTimer.unref?.();
    }
    return {
      notifyUsage: (featureId, usedAt = Date.now()) => {
        const usage = this.lastUsages.get(featureId);
        if (!usage) {
          throw new Error(`Feature '${featureId}' is not registered.`);
        }

        const lastUsed = isDate(usedAt) ? usedAt : new Date(usedAt);
        if (usage.lastUsed == null || lastUsed > usage.lastUsed) {
          usage.lastUsed = lastUsed;
        }
        store?.record(featureId, lastUsed);
      },
      getLastUsages: async () => {
        const stored = (await store?.read()) ?? new Map<string, Date>();
        return Array.from(this.lastUsages.values()).map((usage) => {
          const storedAt = stored.get(usage.id);
          const lastUsed =
            storedAt && (usage.lastUsed == null || storedAt > usage.lastUsed)
              ? storedAt
              : usage.lastUsed;
          return { ...usage, lastUsed };
        });
      },
    };
  }

  /** Writes what is left to the store, once, when the node stops. */
  public async stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    await this.store?.flush();
  }
}
