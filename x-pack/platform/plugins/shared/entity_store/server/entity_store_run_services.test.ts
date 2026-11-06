/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { CRUDClient } from './domain/crud';
import { createEntityStoreRunServices } from './entity_store_run_services';

describe('createEntityStoreRunServices', () => {
  it('creates the CRUD client of a namespace', () => {
    const { createCRUDClient } = createEntityStoreRunServices({
      logger: loggingSystemMock.createLogger(),
    });

    expect(
      createCRUDClient(elasticsearchServiceMock.createElasticsearchClient(), 'default')
    ).toBeInstanceOf(CRUDClient);
  });
});
