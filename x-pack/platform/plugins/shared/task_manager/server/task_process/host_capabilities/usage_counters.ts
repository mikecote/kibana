/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type {
  SavedObjectsServiceSetup,
  SavedObjectsServiceStart,
} from '@kbn/core-saved-objects-server';
import type { UsageCollectionTaskProcessSettings } from '@kbn/usage-collection-plugin/server';
import { UsageCountersService } from '@kbn/usage-collection-plugin/server/usage_counters/usage_counters_service';
import type { TaskHost } from '../../task_type_module';

/** What a process counts with when Kibana did not say otherwise: the defaults of its config. */
const DEFAULTS: UsageCollectionTaskProcessSettings['usageCounters'] = {
  enabled: true,
  retryCount: 3,
  bufferDurationMs: 5000,
};

export interface StandaloneUsageCounters {
  /** Registers the saved object types counters are stored in; at the setup of Core. */
  setup: (savedObjects: SavedObjectsServiceSetup) => void;
  /** Starts storing the counters; at the start of Core. */
  start: (savedObjects: SavedObjectsServiceStart) => NonNullable<TaskHost['usageCounters']>;
  /** Stores what the run counted and waits for it, so it is there when the run answers. */
  flush: () => Promise<void>;
  stop: () => void;
}

/**
 * The usage counters of a task process: Kibana's own `UsageCountersService`, which stores the counts
 * in the same saved objects (one per counter and day) as the usage collection plugin does. The
 * counters are stored when a run ends, not on the interval, and the daily clean-up stays with Kibana.
 */
export const createStandaloneUsageCounters = ({
  logger,
  settings,
}: {
  logger: Logger;
  /** The usage collection config of Kibana. */
  settings?: Partial<UsageCollectionTaskProcessSettings>;
}): StandaloneUsageCounters => {
  const config = { ...DEFAULTS, ...settings?.usageCounters };
  const service = new UsageCountersService({
    logger,
    retryCount: config.retryCount,
    bufferDurationMs: config.bufferDurationMs,
  });
  let counters: ReturnType<UsageCountersService['setup']> | undefined;
  return {
    setup: (savedObjects) => {
      counters = service.setup({ savedObjects });
    },
    start: (savedObjects) => {
      // As Kibana: with `usageCollection.usageCounters.enabled: false` nothing is stored.
      if (config.enabled) service.start({ savedObjects, skipRollups: true });
      else service.stop();
      return {
        // Counters are made once per domain in Kibana; runs ask for them each time they run.
        getUsageCounter: (domainId, params) =>
          counters!.getUsageCounterByDomainId(domainId) ??
          counters!.createUsageCounter(domainId, params),
      };
    },
    flush: () => (config.enabled ? service.flush() : Promise.resolve()),
    stop: () => {
      service.stop();
    },
  };
};
