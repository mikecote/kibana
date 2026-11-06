/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ElasticsearchServiceStart,
  ISavedObjectsRepository,
  KibanaRequest,
  Logger,
  SavedObjectsClientContract,
} from '@kbn/core/server';
import type { EncryptedSavedObjectsClient } from '@kbn/encrypted-saved-objects-plugin/server';
import { extractApiKeyIdFromAuthzHeader } from '@kbn/core-security-server';
import type { ActionsConfigurationUtilities } from '../actions_config';
import type { Services, UnsecuredServices } from '../types';
import { ConnectorTokenClient } from './connector_token_client';

/** The services a connector gets when it runs for a request: what the executor hands `getServices`. */
export const getServicesFactory = ({
  logger,
  getScopedClient,
  elasticsearch,
  encryptedSavedObjectsClient,
  unsecuredSavedObjectsClient,
  configurationUtilities,
}: {
  logger: Logger;
  getScopedClient: (request: KibanaRequest) => SavedObjectsClientContract;
  elasticsearch: Pick<ElasticsearchServiceStart, 'client'>;
  encryptedSavedObjectsClient: EncryptedSavedObjectsClient;
  unsecuredSavedObjectsClient: (request: KibanaRequest) => SavedObjectsClientContract;
  configurationUtilities: ActionsConfigurationUtilities;
}): ((request: KibanaRequest) => Services) => {
  return (request) => ({
    savedObjectsClient: getScopedClient(request),
    scopedClusterClient: elasticsearch.client.asScoped(request).asCurrentUser,
    connectorTokenClient: new ConnectorTokenClient({
      unsecuredSavedObjectsClient: unsecuredSavedObjectsClient(request),
      encryptedSavedObjectsClient,
      logger,
      configurationUtilities,
    }),
  });
};

/** The services a connector gets when it runs without a request (unsecured execution). */
export const getUnsecuredServicesFactory = ({
  logger,
  getSavedObjectRepository,
  elasticsearch,
  encryptedSavedObjectsClient,
  unsecuredSavedObjectsRepository,
  configurationUtilities,
}: {
  logger: Logger;
  getSavedObjectRepository: () => ISavedObjectsRepository;
  elasticsearch: Pick<ElasticsearchServiceStart, 'client'>;
  encryptedSavedObjectsClient: EncryptedSavedObjectsClient;
  unsecuredSavedObjectsRepository: () => SavedObjectsClientContract;
  configurationUtilities: ActionsConfigurationUtilities;
}): (() => UnsecuredServices) => {
  return () => ({
    savedObjectsClient: getSavedObjectRepository(),
    scopedClusterClient: elasticsearch.client.asInternalUser,
    connectorTokenClient: new ConnectorTokenClient({
      unsecuredSavedObjectsClient: unsecuredSavedObjectsRepository(),
      encryptedSavedObjectsClient,
      logger,
      configurationUtilities,
    }),
  });
};

/**
 * Resolves the profile UID from the `Authorization` API key header for callers that run under a fake
 * request (action executor, background execution), where there is no browser session and
 * `userProfiles.getCurrent` cannot run.
 */
export const getCurrentUserProfileIdFromAPIKeyFactory =
  ({
    logger,
    elasticsearch,
  }: {
    logger: Logger;
    elasticsearch: Pick<ElasticsearchServiceStart, 'client'>;
  }) =>
  async (request: KibanaRequest): Promise<string | undefined> => {
    try {
      const id = extractApiKeyIdFromAuthzHeader(request.headers.authorization);
      if (!id) {
        logger.debug(`Failed to decode API key ID from Authorization header.`);
        return undefined;
      }

      const response = await elasticsearch.client
        .asScoped(request)
        .asCurrentUser.security.getApiKey({ with_profile_uid: true, id });

      if (response.api_keys && response.api_keys.length > 0) {
        return response.api_keys[0].profile_uid;
      }

      logger.debug(`No API keys were returned from query, cannot retrieve associated profile id.`);
    } catch (error) {
      logger.debug(
        `Failed to retrieve API key for user profile retrieval: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return undefined;
  };
