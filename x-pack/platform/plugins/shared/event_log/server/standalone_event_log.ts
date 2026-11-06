/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { ClusterClientAdapter } from './es/cluster_client_adapter';
import { RETRY_DELAY } from './es/context';
import type { EsContext } from './es/context';
import { getEsNames } from './es/names';
import { EventLogService } from './event_log_service';
import type { IEventLogService } from './types';
import { SavedObjectProviderRegistry } from './saved_object_provider_registry';

/** The default saved objects index, which the event log names its data stream after. */
const MAIN_SAVED_OBJECT_INDEX = '.kibana';

/**
 * Writes events from a task process straight to the event log data stream with the same service and
 * Elasticsearch adapter Kibana uses. Kibana owns installing the templates and the data stream, so
 * this treats them as ready; only the writing half of the plugin is available (no query client).
 * `stop` flushes the events the adapter still buffers.
 */
export const createStandaloneEventLog = ({
  asInternalUser,
  logger,
  kibanaUuid,
  kibanaVersion,
  providers,
}: {
  asInternalUser: ElasticsearchClient;
  logger: Logger;
  /** Kibana's, so events carry the same `kibana.server_uuid` as when Kibana writes them. */
  kibanaUuid?: string;
  kibanaVersion: string;
  providers: Array<{ provider: string; actions: string[] }>;
}): { eventLog: IEventLogService; stop: () => Promise<void> } => {
  const esNames = getEsNames(MAIN_SAVED_OBJECT_INDEX);
  const esAdapter = new ClusterClientAdapter({
    logger,
    elasticsearchClientPromise: Promise.resolve(asInternalUser),
    esNames,
    wait: async () => true,
  });
  const esContext: EsContext = {
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
  const service = new EventLogService({
    config: { indexEntries: true, logEntries: false } as never,
    esContext,
    systemLogger: logger,
    kibanaUUID: kibanaUuid ?? randomUUID(),
    savedObjectProviderRegistry: new SavedObjectProviderRegistry(),
    kibanaVersion,
  });
  providers.forEach(({ provider, actions }) => service.registerProviderActions(provider, actions));
  return { eventLog: service, stop: () => esContext.shutdown() };
};
