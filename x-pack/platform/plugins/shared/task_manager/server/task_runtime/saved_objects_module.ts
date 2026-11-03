/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Logger } from '@kbn/core-di';
import { CoreSetup, CoreStart } from '@kbn/core-di-server';
import { PodSavedObjects } from '@kbn/core-task-host-server-internal/src/pod_saved_objects';
import { defineServiceModule } from './task_type';

/**
 * Saved objects for a task process: Core's repository, type registry and document migrations over
 * the process's Elasticsearch client, without Core's saved objects service. A service module that
 * registers types does so in an `OnSetup` hook through `CoreSetup('savedObjects')`; the repository
 * is created on first use of `CoreStart('savedObjects')`, which resolves asynchronously.
 *
 * Only task types that list this module pay for the saved objects implementation.
 */
export const savedObjectsModule = defineServiceModule({
  id: 'core.savedObjects',
  load: ({ bind }) => {
    const savedObjects = new PodSavedObjects();
    bind(CoreSetup('savedObjects')).toConstantValue(savedObjects.setup as never);
    bind(CoreStart('savedObjects'))
      .toResolvedValue(
        async (elasticsearch, logger) => {
          await savedObjects.load();
          return savedObjects.start(elasticsearch.client.asInternalUser as never, logger as never);
        },
        [CoreStart('elasticsearch'), Logger]
      )
      .inSingletonScope();
  },
});
