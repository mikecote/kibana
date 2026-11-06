/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessFallbackCounter } from './fallback_counter';

describe('TaskProcessFallbackCounter', () => {
  it('counts the fallbacks by task type and reason, and warns with the reason', () => {
    const logger = { warn: jest.fn() };
    const counter = new TaskProcessFallbackCounter(logger);
    counter.increment('alerting:a', 'declined', 'lacks .new');
    counter.increment('alerting:a', 'declined');
    counter.increment('alerting:a', 'unavailable');
    counter.increment('alerting:b', 'not_served');

    expect(counter.getCounts()).toEqual({
      'alerting:a': { declined: 2, not_served: 0, unavailable: 1 },
      'alerting:b': { declined: 0, not_served: 1, unavailable: 0 },
    });
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(declined): lacks .new'));
  });
});
