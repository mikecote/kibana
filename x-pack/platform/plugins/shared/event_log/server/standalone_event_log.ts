/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { createStandaloneEventLogContext } from './standalone_es_context';
import { EventLogService } from './event_log_service';
import type { IEventLogService } from './types';
import { SavedObjectProviderRegistry } from './saved_object_provider_registry';

/** Builds the native event-log writer using the resources installed by Kibana. */
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
}): { eventLog: IEventLogService; flush: () => Promise<void>; stop: () => Promise<void> } => {
  const esContext = createStandaloneEventLogContext({ asInternalUser, logger });
  const service = new EventLogService({
    config: { indexEntries: true, logEntries: false } as never,
    esContext,
    systemLogger: logger,
    kibanaUUID: kibanaUuid ?? randomUUID(),
    savedObjectProviderRegistry: new SavedObjectProviderRegistry(),
    kibanaVersion,
  });
  providers.forEach(({ provider, actions }) => service.registerProviderActions(provider, actions));
  return {
    eventLog: service,
    flush: () => esContext.esAdapter.flush(),
    stop: () => esContext.shutdown(),
  };
};
