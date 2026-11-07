/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, elasticsearchServiceMock, httpServerMock } from '@kbn/core/server/mocks';
import { UI_SETTINGS } from '@kbn/data-plugin/server';
import { callWithRequest } from './call_with_request';

const createContext = () => {
  const client = elasticsearchServiceMock.createScopedClusterClient();
  const core = coreMock.createStart();
  const savedObjects = core.savedObjects.getScopedClient(httpServerMock.createKibanaRequest());
  const uiSettings = jest.mocked(core.uiSettings.asScopedToClient(savedObjects));
  return {
    client,
    uiSettings,
    context: {
      core: Promise.resolve({ elasticsearch: { client }, uiSettings: { client: uiSettings } }),
    },
  };
};

it('passes the native search timeout as a transport option and preserves frozen-index behavior', async () => {
  const { client, uiSettings, context } = createContext();
  uiSettings.get.mockResolvedValue(true);
  client.asCurrentUser.search.mockResolvedValue({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: { total: { value: 0, relation: 'eq' }, max_score: null, hits: [] },
  });
  await callWithRequest(context, 'search', { index: 'metrics-*', size: 0, requestTimeout: '30s' });
  expect(uiSettings.get).toHaveBeenCalledWith(UI_SETTINGS.SEARCH_INCLUDE_FROZEN);
  expect(client.asCurrentUser.search).toHaveBeenCalledWith(
    { index: 'metrics-*', size: 0, ignore_throttled: false },
    { signal: expect.any(AbortSignal), requestTimeout: '30s' }
  );
});

it('applies the native msearch shard-concurrency setting without leaking a search timeout into the body', async () => {
  const { client, uiSettings, context } = createContext();
  uiSettings.get.mockResolvedValueOnce(false).mockResolvedValueOnce(3);
  client.asCurrentUser.msearch.mockResolvedValue({ took: 1, responses: [] });
  await callWithRequest(context, 'msearch', { searches: [], requestTimeout: '30s' });
  expect(uiSettings.get.mock.calls).toEqual([
    [UI_SETTINGS.SEARCH_INCLUDE_FROZEN],
    [UI_SETTINGS.COURIER_MAX_CONCURRENT_SHARD_REQUESTS],
  ]);
  expect(client.asCurrentUser.msearch).toHaveBeenCalledWith(
    { searches: [], max_concurrent_shard_requests: 3 },
    { signal: expect.any(AbortSignal) }
  );
});
