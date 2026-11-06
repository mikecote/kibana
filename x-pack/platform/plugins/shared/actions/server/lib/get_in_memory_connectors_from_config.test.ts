/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema } from '../config';
import { getInMemoryConnectorsFromConfig } from './get_in_memory_connectors_from_config';

describe('getInMemoryConnectorsFromConfig', () => {
  const logger = loggingSystemMock.createLogger();

  it('has no connectors without configuration', () => {
    expect(getInMemoryConnectorsFromConfig(configSchema.validate({}), logger)).toEqual([]);
  });

  it('has the alert history index connector when it is on', () => {
    const connectors = getInMemoryConnectorsFromConfig(
      configSchema.validate({ preconfiguredAlertHistoryEsIndex: true }),
      logger
    );
    expect(connectors.map((connector) => connector.actionTypeId)).toEqual(['.index']);
  });

  it('has the preconfigured connectors, marked as preconfigured', () => {
    const connectors = getInMemoryConnectorsFromConfig(
      configSchema.validate({
        preconfigured: {
          'my-log': { name: 'log', actionTypeId: '.server-log' },
        },
      }),
      logger
    );
    expect(connectors).toEqual([
      expect.objectContaining({
        id: 'my-log',
        actionTypeId: '.server-log',
        isPreconfigured: true,
        isSystemAction: false,
      }),
    ]);
  });

  it('refuses a preconfigured connector with the reserved alert history id', () => {
    const connectors = getInMemoryConnectorsFromConfig(
      configSchema.validate({
        preconfigured: {
          'preconfigured-alert-history-es-index': {
            name: 'x',
            actionTypeId: '.index',
            config: { index: 'x' },
          },
        },
      }),
      logger
    );
    expect(connectors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reserved id'));
  });
});
