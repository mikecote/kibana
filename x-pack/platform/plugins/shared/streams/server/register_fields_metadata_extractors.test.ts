/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import type { Streams } from '@kbn/streams-schema';
import { createStreamsStorageClient } from './lib/streams/storage/streams_storage_client';
import { createStreamsFieldsMetadataExtractor } from './register_fields_metadata_extractors';

jest.mock('./lib/streams/storage/streams_storage_client', () => ({
  createStreamsStorageClient: jest.fn(),
}));

const shared = {
  name: 'logs.orders',
  description: 'Order logs',
  updated_at: '2026-11-07T00:00:00.000Z',
};
const ingest = {
  processing: { steps: [], updated_at: shared.updated_at },
  lifecycle: { inherit: {} },
  failure_store: { inherit: {} },
  settings: {},
};
const definitions: Streams.all.Definition[] = [
  {
    ...shared,
    type: 'classic',
    ingest: {
      ...ingest,
      classic: {
        field_overrides: { order_id: { type: 'keyword', description: 'Order identity' } },
      },
    },
  },
  {
    ...shared,
    type: 'wired',
    ingest: {
      ...ingest,
      wired: {
        fields: { order_id: { type: 'keyword', description: 'Order identity' } },
        routing: [],
      },
    },
  },
];

describe('Streams field metadata execution extractor', () => {
  it.each(definitions)(
    'reads $type definitions with the supplied request-scoped Elasticsearch client',
    async (definition) => {
      const esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
      const logger = loggerMock.create();
      const get = jest.fn().mockResolvedValue({ _source: definition });
      const storage = jest
        .requireActual<typeof import('./lib/streams/storage/streams_storage_client')>(
          './lib/streams/storage/streams_storage_client'
        )
        .createStreamsStorageClient(esClient, logger);
      jest.spyOn(storage, 'get').mockImplementation(get);
      jest.mocked(createStreamsStorageClient).mockReturnValue(storage);
      const extract = createStreamsFieldsMetadataExtractor({ logger });
      await expect(extract({ streamName: shared.name, esClient })).resolves.toEqual({
        order_id: { name: 'order_id', type: 'keyword', description: 'Order identity' },
      });
      expect(createStreamsStorageClient).toHaveBeenCalledWith(esClient, logger);
      expect(get).toHaveBeenCalledWith({ id: shared.name });
    }
  );

  it('preserves native handling of inaccessible definitions without using another Elasticsearch client', async () => {
    const esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
    const get = jest.fn().mockRejectedValue(new Error('Forbidden'));
    const logger = loggerMock.create();
    const storage = jest
      .requireActual<typeof import('./lib/streams/storage/streams_storage_client')>(
        './lib/streams/storage/streams_storage_client'
      )
      .createStreamsStorageClient(esClient, logger);
    jest.spyOn(storage, 'get').mockImplementation(get);
    jest.mocked(createStreamsStorageClient).mockReturnValue(storage);
    await expect(
      createStreamsFieldsMetadataExtractor({ logger })({
        streamName: shared.name,
        esClient,
      })
    ).resolves.toEqual({});
    expect(get).toHaveBeenCalledTimes(1);
  });
});
