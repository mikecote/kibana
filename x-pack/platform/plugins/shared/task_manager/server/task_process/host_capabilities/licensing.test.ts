/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createStandaloneFeatureUsage } from './licensing';

describe('createStandaloneFeatureUsage', () => {
  const logger = loggingSystemMock.createLogger();

  it('writes the usage of a run to the store shared by every node when it is flushed', async () => {
    const repository = { update: jest.fn().mockResolvedValue({}), find: jest.fn() };
    const { featureUsage, flush } = createStandaloneFeatureUsage({ repository, logger });

    featureUsage.notifyUsage('Machine Learning', new Date('2026-01-01T00:00:00.000Z'));
    featureUsage.notifyUsage('Machine Learning', Date.parse('2026-01-02T00:00:00.000Z'));
    expect(repository.update).not.toHaveBeenCalled();
    await flush();

    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith(
      'licensing-feature-usage',
      'Machine Learning',
      { lastUsed: '2026-01-02T00:00:00.000Z' },
      { upsert: { lastUsed: '2026-01-02T00:00:00.000Z' } }
    );
  });

  it('uses the current time when the usage has none', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-04T00:00:00.000Z'));
    const repository = { update: jest.fn().mockResolvedValue({}), find: jest.fn() };
    const { featureUsage, flush } = createStandaloneFeatureUsage({ repository, logger });

    featureUsage.notifyUsage('Feature');
    await flush();

    expect(repository.update).toHaveBeenCalledWith(
      'licensing-feature-usage',
      'Feature',
      { lastUsed: '2026-03-04T00:00:00.000Z' },
      expect.anything()
    );
    jest.restoreAllMocks();
  });
});
