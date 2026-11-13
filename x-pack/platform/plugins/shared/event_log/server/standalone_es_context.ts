/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { ClusterClientAdapter } from './es/cluster_client_adapter';
import { RETRY_DELAY } from './es/context';
import type { EsContext } from './es/context';
import { getEsNames } from './es/names';

/** Opens the event-log resources installed by Kibana for a task execution. */
export const createStandaloneEventLogContext = ({
  asInternalUser,
  logger,
}: {
  asInternalUser: ElasticsearchClient;
  logger: Logger;
}): EsContext => {
  const esNames = getEsNames('.kibana');
  const esAdapter = new ClusterClientAdapter({
    logger,
    elasticsearchClientPromise: Promise.resolve(asInternalUser),
    esNames,
    wait: async () => true,
  });
  return {
    logger,
    esNames,
    esAdapter,
    initialize: () => undefined,
    shutdown: () => esAdapter.shutdown(),
    waitTillReady: async () => true,
    initialized: true,
    retryDelay: RETRY_DELAY,
    shouldSetExistingAssetsToHidden: false,
  };
};
