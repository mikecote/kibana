/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { savedObjectsClientMock } from '@kbn/core-saved-objects-api-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { createSloDetailsDataProvider } from '../agent_builder/register_data_provider';
import { createScopedSloClient } from './create_scoped_slo_client';

describe('native scoped SLO data providers', () => {
  const createServices = () => {
    const savedObjects = savedObjectsServiceMock.createStartContract();
    const scopedObjects = savedObjectsClientMock.create();
    savedObjects.getScopedClient.mockReturnValue(scopedObjects);
    const client = elasticsearchServiceMock.createClusterClient();
    const getSpaceId = jest.fn().mockResolvedValue('operations');
    const getClient = createScopedSloClient({
      savedObjects,
      elasticsearch: { client },
      getSpaceId,
      logger: loggerMock.create(),
    });
    return {
      savedObjects,
      scopedObjects,
      client,
      getSpaceId,
      provider: createSloDetailsDataProvider(getClient),
    };
  };

  it('propagates saved object access denial from the executing request', async () => {
    const { savedObjects, scopedObjects, client, provider } = createServices();
    const request = httpServerMock.createKibanaRequest();
    scopedObjects.find.mockRejectedValue(new Error('SLO access denied'));

    await expect(provider({ request, sloId: 'private-slo' })).rejects.toThrow('SLO access denied');

    expect(savedObjects.getScopedClient).toHaveBeenLastCalledWith(request);
    expect(client.asScoped).toHaveBeenCalledWith(request);
    expect(client.asInternalUser.search).not.toHaveBeenCalled();
  });

  it('resolves the current space per request and searches remote definitions as the current user', async () => {
    const { client, getSpaceId, provider } = createServices();
    const firstRequest = httpServerMock.createKibanaRequest();
    const secondRequest = httpServerMock.createKibanaRequest();
    const scopedClient = client.asScoped();
    scopedClient.asCurrentUser.search.mockResponse({
      took: 0,
      timed_out: false,
      _shards: { total: 1, successful: 1, failed: 0, skipped: 0 },
      hits: { hits: [], total: 0 },
    });

    await expect(
      provider({ request: firstRequest, sloId: 'remote-slo', remoteName: 'production' })
    ).rejects.toThrow('spaceId=operations');
    getSpaceId.mockResolvedValue('engineering');
    await expect(
      provider({ request: secondRequest, sloId: 'remote-slo', remoteName: 'production' })
    ).rejects.toThrow('spaceId=engineering');

    expect(getSpaceId.mock.calls).toEqual([[firstRequest], [secondRequest]]);
    expect(client.asScoped).toHaveBeenLastCalledWith(secondRequest);
    expect(scopedClient.asCurrentUser.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        index: expect.stringMatching(/^production:/),
        query: {
          bool: {
            filter: [{ term: { spaceId: 'engineering' } }, { term: { 'slo.id': 'remote-slo' } }],
          },
        },
      })
    );
    expect(client.asInternalUser.search).not.toHaveBeenCalled();
  });
});
