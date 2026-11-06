/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { savedObjectsClientMock } from '@kbn/core-saved-objects-api-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { actionsConfigMock } from '../actions_config.mock';
import {
  getCurrentUserProfileIdFromAPIKeyFactory,
  getServicesFactory,
  getUnsecuredServicesFactory,
} from './executor_services';

const logger = loggingSystemMock.createLogger();
const request = { headers: {} } as unknown as KibanaRequest;

describe('executor services', () => {
  const elasticsearch = elasticsearchServiceMock.createStart();
  const encryptedSavedObjectsClient = encryptedSavedObjectsMock.createClient();

  it('gives a connector the clients of the request it runs for', () => {
    const savedObjectsClient = savedObjectsClientMock.create();
    const services = getServicesFactory({
      logger,
      getScopedClient: () => savedObjectsClient,
      elasticsearch,
      encryptedSavedObjectsClient,
      unsecuredSavedObjectsClient: () => savedObjectsClientMock.create(),
      configurationUtilities: actionsConfigMock.create(),
    })(request);

    expect(services.savedObjectsClient).toBe(savedObjectsClient);
    expect(elasticsearch.client.asScoped).toHaveBeenCalledWith(request);
    expect(services.connectorTokenClient).toBeDefined();
  });

  it('gives a connector run without a request the internal user', () => {
    const repository = savedObjectsClientMock.create();
    const services = getUnsecuredServicesFactory({
      logger,
      getSavedObjectRepository: () => repository as never,
      elasticsearch,
      encryptedSavedObjectsClient,
      unsecuredSavedObjectsRepository: () => savedObjectsClientMock.create(),
      configurationUtilities: actionsConfigMock.create(),
    })();

    expect(services.savedObjectsClient).toBe(repository);
    expect(services.scopedClusterClient).toBe(elasticsearch.client.asInternalUser);
  });

  describe('the profile of the user of an API key', () => {
    const apiKeyRequest = {
      headers: { authorization: `ApiKey ${Buffer.from('key-id:secret').toString('base64')}` },
    } as unknown as KibanaRequest;

    it('is read from the API key of the request', async () => {
      elasticsearch.client.asScoped.mockReturnValue({
        asCurrentUser: {
          security: {
            getApiKey: jest.fn().mockResolvedValue({ api_keys: [{ profile_uid: 'profile-1' }] }),
          },
        },
      } as never);

      await expect(
        getCurrentUserProfileIdFromAPIKeyFactory({ logger, elasticsearch })(apiKeyRequest)
      ).resolves.toBe('profile-1');
    });

    it('is not found when the request has no API key', async () => {
      await expect(
        getCurrentUserProfileIdFromAPIKeyFactory({ logger, elasticsearch })(request)
      ).resolves.toBeUndefined();
    });

    it('is not found when Elasticsearch fails, which never fails the action', async () => {
      elasticsearch.client.asScoped.mockImplementation(() => {
        throw new Error('unavailable');
      });

      await expect(
        getCurrentUserProfileIdFromAPIKeyFactory({ logger, elasticsearch })(apiKeyRequest)
      ).resolves.toBeUndefined();
    });
  });
});
