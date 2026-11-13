/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock } from '@kbn/core/server/mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { createFieldFormatsStartMock } from '@kbn/field-formats-plugin/server/mocks';
import { createIndexPatternsStartMock } from '@kbn/data-views-plugin/server/mocks';
import { ES_SEARCH_STRATEGY } from '../../common/search';
import { createStandaloneSearch } from './standalone_search';

describe('native scoped search lifecycle', () => {
  const build = () => {
    const core = coreMock.createStart();
    const request = httpServerMock.createKibanaRequest();
    const search = createStandaloneSearch({
      logger: loggerMock.create(),
      elasticsearch: core.elasticsearch,
      savedObjects: core.savedObjects,
      uiSettings: core.uiSettings,
      dataViews: createIndexPatternsStartMock(),
      fieldFormats: createFieldFormatsStartMock(),
    });
    return { core, request, search };
  };

  it('cancels and extends native async searches as the request principal with project routing', async () => {
    const { core, request, search } = build();
    const scoped = core.elasticsearch.client.asScoped(request);
    const options = { projectRouting: 'space' } as const;
    const client = search.asScoped(request, options);

    await client.cancel('owned-search');
    await client.extend('owned-search', '5m');

    expect(core.elasticsearch.client.asScoped).toHaveBeenLastCalledWith(request, options);
    expect(scoped.asCurrentUser.asyncSearch.delete).toHaveBeenCalledWith({ id: 'owned-search' });
    expect(scoped.asCurrentUser.asyncSearch.get).toHaveBeenCalledWith({
      id: 'owned-search',
      keep_alive: '5m',
    });
    expect(core.elasticsearch.client.asInternalUser.asyncSearch.delete).not.toHaveBeenCalled();
  });

  it('reports unsupported lifecycle operations and unknown strategies explicitly', async () => {
    const { request, search } = build();
    const client = search.asScoped(request);
    expect(() => client.cancel('id', { strategy: ES_SEARCH_STRATEGY })).toThrow(
      "doesn't support cancellations"
    );
    await expect(client.extend('id', '5m', { strategy: ES_SEARCH_STRATEGY })).rejects.toThrow(
      'does not support extend'
    );
    expect(() => client.cancel('id', { strategy: 'missing' })).toThrow(
      'Search strategy missing not found'
    );
    await expect(client.extend('id', '5m', { strategy: 'missing' })).rejects.toThrow(
      'Search strategy missing not found'
    );
  });
});
