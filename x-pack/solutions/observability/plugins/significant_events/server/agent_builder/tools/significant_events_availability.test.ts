/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createSignificantEventsAvailability } from './significant_events_availability';

describe('significant events tool availability', () => {
  it('uses the execution access checker on each availability evaluation', async () => {
    const assertAccess = jest.fn().mockResolvedValue(undefined);
    const availability = createSignificantEventsAvailability({
      assertAccess,
      logger: loggerMock.create(),
    });
    expect(availability.cacheMode).toBe('space');
    await expect(availability.handler()).resolves.toEqual({ status: 'available' });
    assertAccess.mockRejectedValueOnce(new Error('Nightshift disabled'));
    await expect(availability.handler()).resolves.toEqual({
      status: 'unavailable',
      reason: 'Nightshift disabled',
    });
    await expect(availability.handler()).resolves.toEqual({ status: 'available' });
    expect(assertAccess).toHaveBeenCalledTimes(3);
    expect(assertAccess).toHaveBeenLastCalledWith();
  });

  it('logs failed access reads and preserves their native error message', async () => {
    const logger = loggerMock.create();
    const error = new Error('License read failed');
    const availability = createSignificantEventsAvailability({
      assertAccess: jest.fn().mockRejectedValue(error),
      logger,
    });
    await expect(availability.handler()).resolves.toEqual({
      status: 'unavailable',
      reason: error.message,
    });
    expect(logger.debug).toHaveBeenCalledWith(error.stack);
  });
});
