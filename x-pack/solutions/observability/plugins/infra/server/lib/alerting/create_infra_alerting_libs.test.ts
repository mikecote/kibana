/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createLogSourcesServiceFactory } from '@kbn/logs-data-access-plugin/server/services/log_sources_service';
import { createLogViewsClientGetter } from './create_infra_alerting_libs';

jest.mock('@kbn/logs-data-access-plugin/server/services/log_sources_service', () => ({
  createLogSourcesServiceFactory: jest.fn(() => ({ getLogSourcesService: jest.fn() })),
}));

describe('createLogViewsClientGetter', () => {
  it('gives the log sources service the saved objects of the services, read when needed', () => {
    const savedObjects = { getScopedClient: jest.fn() };
    const getServices = jest.fn(() => ({ savedObjects, uiSettings: {}, dataViews: {} } as never));

    createLogViewsClientGetter({
      logger: loggingSystemMock.createLogger(),
      sources: {} as never,
      configuration: {} as never,
      isServerless: false,
      getServices,
    });

    // Building the getter reads nothing: a rule type is built before the services exist.
    expect(getServices).not.toHaveBeenCalled();
    const { deps } = (createLogSourcesServiceFactory as jest.Mock).mock.calls[0][0];
    expect(deps.savedObjects).toBe(savedObjects);
    expect(getServices).toHaveBeenCalledTimes(1);
  });
});
