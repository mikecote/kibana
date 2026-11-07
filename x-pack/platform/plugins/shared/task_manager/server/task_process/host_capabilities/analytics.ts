/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup } from '@kbn/core-analytics-server';
import type { TaskTypeModule } from '../../task_type_module';

/** Registers native event schemas once across static declarations and typed registration callbacks. */
export const registerTaskAnalyticsEventTypes = (
  module: Pick<TaskTypeModule, 'analyticsEventTypes' | 'registerAnalyticsEventTypes'>,
  analytics: Pick<AnalyticsServiceSetup, 'registerEventType'>
): void => {
  const eventTypes = new Set<string>();
  const registration: Pick<AnalyticsServiceSetup, 'registerEventType'> = {
    registerEventType: (eventType) => {
      if (eventTypes.has(eventType.eventType)) return;
      eventTypes.add(eventType.eventType);
      analytics.registerEventType(eventType);
    },
  };
  for (const eventType of module.analyticsEventTypes ?? []) {
    registration.registerEventType(eventType);
  }
  module.registerAnalyticsEventTypes?.(registration);
};
