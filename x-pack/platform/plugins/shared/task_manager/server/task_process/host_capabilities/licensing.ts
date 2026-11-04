/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import { defer, from, shareReplay } from 'rxjs';
import type { ILicense } from '@kbn/licensing-types';
import type { Logger } from '@kbn/logging';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import { getLicenseFetcher } from '@kbn/licensing-plugin/server/license_fetcher';
import type { TaskHost } from '../../task_type_module';

/**
 * The license, fetched once from Elasticsearch when a module first reads it: a process serves one
 * run, and a remote process restarts rarely enough that Kibana's polling is not worth replicating.
 */
export const createStandaloneLicensing = ({
  asInternalUser,
  logger,
}: {
  asInternalUser: ElasticsearchClient;
  logger: Logger;
}): NonNullable<TaskHost['licensing']> => {
  const fetchLicense = getLicenseFetcher({
    clusterClient: { asInternalUser } as never,
    logger: logger as never,
    cacheDurationMs: 60_000,
    maxRetryDelay: 30_000,
  });
  // Built on first subscription, so a module that never reads the license never calls Elasticsearch.
  return {
    license$: defer(() => from(fetchLicense())).pipe(shareReplay(1)) as Observable<ILicense>,
  };
};
