/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import type { EventTypeOpts } from '@kbn/core-analytics-server';
import { registerTaskAnalyticsEventTypes } from './analytics';

describe('task analytics schema registration', () => {
  it('preserves optional nested schemas and deduplicates static and callback registrations', () => {
    const { analytics } = coreMock.createSetup();
    const basic = { eventType: 'basic', schema: {} };
    const nested: EventTypeOpts<{ details?: { count: number } }> = {
      eventType: 'optional.details',
      schema: {
        details: {
          _meta: { description: 'Optional execution details', optional: true },
          properties: {
            count: { type: 'long', _meta: { description: 'Number of effects' } },
          },
        },
      },
    };
    registerTaskAnalyticsEventTypes(
      {
        analyticsEventTypes: [basic, basic],
        registerAnalyticsEventTypes: (registration) => {
          registration.registerEventType(basic);
          registration.registerEventType(nested);
        },
      },
      analytics
    );
    expect(analytics.registerEventType.mock.calls).toEqual([[basic], [nested]]);
  });
});
