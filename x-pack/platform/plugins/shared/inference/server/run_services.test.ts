/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { RegexWorkerService } from '@kbn/ai-anonymization-server';
import { createInferenceRunServices } from './run_services';
import { getConnectorById, getConnectorByIdWithoutClientRequest } from './util/get_connector_by_id';
import { createClientWithoutRequest } from './inference_client';

jest.mock('./util/get_connector_by_id');
jest.mock('./inference_client', () => ({
  createClientWithoutRequest: jest.fn(),
  createClient: jest.fn(),
  createChatModel: jest.fn(),
}));

describe('createInferenceRunServices', () => {
  const logger = loggingSystemMock.createLogger();
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const actions = { getActionsClientWithRequest: jest.fn() };
  const workers = {
    anonymization: {
      enabled: false,
      minThreads: 0,
      maxThreads: 1,
      maxQueue: 1,
      idleTimeout: { asMilliseconds: () => 1000 },
      taskTimeout: { asMilliseconds: () => 1000 },
    },
  };
  const config = { workers } as never;

  beforeEach(() => jest.clearAllMocks());

  it('does not start a worker pool when workers are disabled', () => {
    const { regexWorker } = createInferenceRunServices({ actions, esClient, logger, config });
    expect(regexWorker).toBeInstanceOf(RegexWorkerService);
    expect(regexWorker.isEnabled()).toBe(false);
  });

  it('looks up a connector with the actions provider and the internal client', async () => {
    const request = httpServerMock.createKibanaRequest();
    const { getConnectorById: lookup } = createInferenceRunServices({
      actions,
      esClient,
      logger,
      config,
    });
    await lookup('my-connector', request);
    expect(getConnectorById).toHaveBeenCalledWith({
      connectorId: 'my-connector',
      actions,
      request,
      esClient,
      logger,
    });
  });

  it('resolves a connector and builds a client with the caller actions client', async () => {
    const services = createInferenceRunServices({ actions, esClient, logger, config });
    const actionsClient = {} as never;
    const scoped = elasticsearchServiceMock.createElasticsearchClient();

    await services.getConnectorByIdWithoutClientRequest('c1', actionsClient, scoped);
    expect(getConnectorByIdWithoutClientRequest).toHaveBeenCalledWith({
      connectorId: 'c1',
      actionsClient,
      esClient: scoped,
      logger,
    });

    services.getClientWithoutRequest(actionsClient, scoped);
    expect(createClientWithoutRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actionsClient,
        esClient: scoped,
        regexWorker: services.regexWorker,
        endpointIdCache: services.endpointIdCache,
      })
    );
  });

  it('shares the instances the plugin passes', () => {
    const regexWorker = new RegexWorkerService(workers.anonymization as never, logger);
    const services = createInferenceRunServices({
      actions,
      esClient,
      logger,
      config,
      regexWorker,
    });
    expect(services.regexWorker).toBe(regexWorker);
  });
});
