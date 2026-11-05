/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock, savedObjectsClientMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';

import { ConfigSchema } from './config';
import { ExceptionListClient } from './services/exception_lists/exception_list_client';
import { ListClient } from './services/lists/list_client';
import {
  LISTS_TASK_PROCESS_SETTINGS_ID,
  createListsRunServices,
  createListsTaskProcessServices,
} from './lists_run_services';

describe('lists run services', () => {
  const config = ConfigSchema.validate({});
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const savedObjectsClient = savedObjectsClientMock.create();

  it('creates the clients of lists and exceptions over the config', () => {
    const getServerExtensionsClient = jest.fn();
    const services = createListsRunServices({ config, getServerExtensionsClient });

    expect(services.getListClient(esClient, 'default', 'elastic')).toBeInstanceOf(ListClient);
    expect(services.getExceptionListClient(savedObjectsClient, 'elastic')).toBeInstanceOf(
      ExceptionListClient
    );
    expect(getServerExtensionsClient).toHaveBeenCalledTimes(1);
  });

  describe('for a task process', () => {
    it('builds the same clients from the settings Kibana sent', () => {
      const services = createListsTaskProcessServices({
        logger: loggingSystemMock.createLogger(),
        settings: { [LISTS_TASK_PROCESS_SETTINGS_ID]: config },
      });

      expect(services.getListClient(esClient, 'default', 'elastic')).toBeInstanceOf(ListClient);
      expect(services.getExceptionListClient(savedObjectsClient, 'elastic')).toBeInstanceOf(
        ExceptionListClient
      );
    });

    it('fails without the settings', () => {
      expect(() =>
        createListsTaskProcessServices({ logger: loggingSystemMock.createLogger(), settings: {} })
      ).toThrow('was not given the settings of lists');
    });
  });
});
