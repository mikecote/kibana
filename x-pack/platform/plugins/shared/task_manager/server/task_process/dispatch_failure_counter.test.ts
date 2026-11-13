/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessDispatchFailureCounter } from './dispatch_failure_counter';

describe('TaskProcessDispatchFailureCounter', () => {
  it('counts dispatch failures by task type and reason, and warns with the reason', () => {
    const logger = { warn: jest.fn() };
    const counter = new TaskProcessDispatchFailureCounter(logger);
    counter.increment('alerting:a', 'declined', 'lacks .new');
    counter.increment('alerting:a', 'declined');
    counter.increment('alerting:a', 'unavailable');
    counter.increment('alerting:b', 'not_served');

    const none = {
      declined: 0,
      not_served: 0,
      incompatible: 0,
      unavailable: 0,
      capacity: 0,
      spawn_failed: 0,
      spawn_timeout: 0,
    };
    expect(counter.getCounts()).toEqual({
      'alerting:a': { ...none, declined: 2, unavailable: 1 },
      'alerting:b': { ...none, not_served: 1 },
    });
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(declined): lacks .new'));
  });
});
