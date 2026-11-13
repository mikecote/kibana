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
import { brandSpaceId } from '@kbn/core-spaces-common';
import { loggerMock } from '@kbn/logging-mocks';
import { createStandaloneEventLogClientService } from './standalone_event_log_client';

describe('standalone event-log reader', () => {
  const es = elasticsearchServiceMock.createElasticsearchClient();
  const savedObjects = savedObjectsServiceMock.createStartContract();
  const scoped = savedObjectsClientMock.create();
  const request = httpServerMock.createFakeKibanaRequest({
    spaceId: brandSpaceId('investigations'),
  });
  let reader: ReturnType<typeof createStandaloneEventLogClientService>;

  beforeEach(() => {
    jest.clearAllMocks();
    savedObjects.getScopedClient.mockReturnValue(scoped);
    scoped.bulkGet.mockResolvedValue({ saved_objects: [] });
    es.search.mockResolvedValue({
      took: 1,
      timed_out: false,
      _shards: { total: 1, successful: 1, failed: 0 },
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    reader = createStandaloneEventLogClientService({
      asInternalUser: es,
      logger: loggerMock.create(),
      savedObjects,
    });
  });

  afterEach(async () => reader.stop());

  it('checks the requesting user before querying events', async () => {
    scoped.bulkGet.mockRejectedValueOnce(new Error('saved-object access denied'));
    await expect(
      reader.clientService.getClient(request).findEventsBySavedObjectIds('action', ['connector-1'])
    ).rejects.toThrow('saved-object access denied');
    expect(savedObjects.getScopedClient).toHaveBeenCalledWith(request);
    expect(es.search).not.toHaveBeenCalled();
  });

  it('uses a connector-specific authorization provider before searching', async () => {
    await reader.stop();
    const provider = jest.fn(() => async () => {
      throw new Error('connector access denied');
    });
    reader = createStandaloneEventLogClientService({
      asInternalUser: es,
      logger: loggerMock.create(),
      savedObjects,
      providers: { action: provider },
    });
    await expect(
      reader.clientService.getClient(request).findEventsBySavedObjectIds('action', ['connector-1'])
    ).rejects.toThrow('connector access denied');
    expect(provider).toHaveBeenCalledWith(request, undefined);
    expect(scoped.bulkGet).not.toHaveBeenCalled();
    expect(es.search).not.toHaveBeenCalled();
  });

  it.each(['request', 'explicit'] as const)(
    'scopes %s-space event reads without a web spaces service',
    async (scope) => {
      const client =
        scope === 'request'
          ? reader.clientService.getClient(request)
          : reader.clientService.getClientWithRequestInSpace(
              request,
              brandSpaceId('explicit-space')
            );
      const result = await client.findEventsBySavedObjectIds('action', ['connector-1']);
      expect(result.total).toBe(0);
      const [query] = es.search.mock.calls[0];
      expect(JSON.stringify(query)).toContain(
        scope === 'request' ? 'investigations' : 'explicit-space'
      );
      expect(JSON.stringify(query)).toContain('kibana.saved_objects.namespace');
      expect(scoped.bulkGet).toHaveBeenCalledWith([{ type: 'action', id: 'connector-1' }]);
    }
  );
});
