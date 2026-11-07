/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { httpServerMock } from '@kbn/core/server/mocks';
import { createObservabilityTaskDataRegistry } from './create_data_registry';

const input = {
  request: httpServerMock.createKibanaRequest(),
  from: '2026-01-01T00:00:00Z',
  to: '2026-01-02T00:00:00Z',
  limit: 1,
  query: undefined,
};

it('defers resolution until execution and rejects a dispatched provider with no native owner', () => {
  const getService = jest.fn();
  const registry = createObservabilityTaskDataRegistry({
    snapshot: { dataProviders: [{ id: 'infraHosts' }] },
    getService,
    logger: loggingSystemMock.createLogger(),
  });
  expect(getService).not.toHaveBeenCalled();
  expect(() => registry.getData('infraHosts', input)).toThrow(
    'Observability data provider infraHosts has no native owner'
  );
  expect(getService).not.toHaveBeenCalled();
});

it('rejects missing native providers without replacing them with another execution path', () => {
  const getService = jest.fn().mockReturnValue({});
  const registry = createObservabilityTaskDataRegistry({
    snapshot: { dataProviders: [{ id: 'infraHosts', owner: 'infra' }] },
    getService,
    logger: loggingSystemMock.createLogger(),
  });
  expect(() => registry.getData('infraHosts', input)).toThrow(
    'Observability data provider infraHosts was not contributed by infra'
  );
  expect(getService).toHaveBeenCalledWith('observabilityAgentBuilder.dataProviders.infra');
});
