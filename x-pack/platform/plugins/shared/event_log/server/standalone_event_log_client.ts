/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger, SavedObjectsServiceStart } from '@kbn/core/server';
import { EventLogClientService } from './event_log_start_service';
import { SavedObjectProviderRegistry } from './saved_object_provider_registry';
import type { SavedObjectProvider } from './saved_object_provider_registry';
import { createStandaloneEventLogContext } from './standalone_es_context';
import type { IEventLogClientService } from './types';

/** Builds the event-log reader with request-scoped saved-object authorization. */
export const createStandaloneEventLogClientService = ({
  asInternalUser,
  logger,
  savedObjects,
  providers = {},
}: {
  asInternalUser: ElasticsearchClient;
  logger: Logger;
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient'>;
  providers?: Readonly<Record<string, SavedObjectProvider>>;
}): { clientService: IEventLogClientService; stop: () => Promise<void> } => {
  const esContext = createStandaloneEventLogContext({ asInternalUser, logger });
  const registry = new SavedObjectProviderRegistry();
  registry.registerDefaultProvider((request) => {
    const client = savedObjects.getScopedClient(request);
    return client.bulkGet.bind(client);
  });
  for (const [type, provider] of Object.entries(providers))
    registry.registerProvider(type, provider);
  return {
    clientService: new EventLogClientService({ esContext, savedObjectProviderRegistry: registry }),
    stop: () => esContext.shutdown(),
  };
};
