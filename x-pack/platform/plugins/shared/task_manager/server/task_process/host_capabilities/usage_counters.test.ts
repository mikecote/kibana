/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { createStandaloneUsageCounters } from './usage_counters';

describe('createStandaloneUsageCounters', () => {
  const logger = loggingSystemMock.createLogger();

  const create = (settings?: Parameters<typeof createStandaloneUsageCounters>[0]['settings']) => {
    const setup = savedObjectsServiceMock.createSetupContract();
    const start = savedObjectsServiceMock.createStartContract();
    const incrementCounter = jest.fn().mockResolvedValue({});
    start.createInternalRepository.mockReturnValue({ incrementCounter } as never);
    const counters = createStandaloneUsageCounters({ logger, settings });
    counters.setup(setup);
    return { counters, setup, start, incrementCounter };
  };

  it('registers the saved object types the counters are stored in', () => {
    const { setup } = create();

    expect(setup.registerType.mock.calls.map(([type]) => type.name).sort()).toEqual([
      'usage-counter',
      'usage-counters',
    ]);
  });

  it('stores what a run counted when it is flushed, not on the interval', async () => {
    const { counters, start, incrementCounter } = create();

    const { getUsageCounter } = counters.start(start);
    const counter = getUsageCounter('alerting');
    counter.incrementCounter({ counterName: 'alertsSkippedDueToRuleExecutionTimeout_a.rule' });
    counter.incrementCounter({ counterName: 'alertsSkippedDueToRuleExecutionTimeout_a.rule' });
    await counters.flush();

    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(incrementCounter).toHaveBeenCalledWith(
      'usage-counter',
      expect.stringContaining(
        'alerting:alertsSkippedDueToRuleExecutionTimeout_a.rule:count:server:'
      ),
      [{ fieldName: 'count', incrementBy: 2 }],
      expect.objectContaining({
        upsertAttributes: expect.objectContaining({ domainId: 'alerting' }),
      })
    );
    counters.stop();
  });

  it('hands out the same counter of a domain every run asks, which Kibana makes once', () => {
    const { counters, start } = create();

    const { getUsageCounter } = counters.start(start);

    expect(getUsageCounter('actions')).toBe(getUsageCounter('actions'));
    expect(getUsageCounter('actions')).not.toBe(getUsageCounter('alerting'));
    counters.stop();
  });

  it('stores nothing when Kibana has usage counters disabled', async () => {
    const { counters, start, incrementCounter } = create({
      usageCounters: { enabled: false, retryCount: 1, bufferDurationMs: 100 },
    });

    counters.start(start).getUsageCounter('alerting').incrementCounter({ counterName: 'c' });
    await counters.flush();

    expect(incrementCounter).not.toHaveBeenCalled();
    counters.stop();
  });
});
