/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup, Logger } from '@kbn/core/server';
import { NightshiftTelemetryClient } from './client';
import { semanticMemoryMaterializedEvent, semanticMemoryOptimizedEvent } from './events';

/** Registers native Nightshift event schemas for Main and task-process analytics. */
export const registerNightshiftTelemetryEvents = (
  analytics: Pick<AnalyticsServiceSetup, 'registerEventType'>
): void => {
  analytics.registerEventType(semanticMemoryMaterializedEvent);
  analytics.registerEventType(semanticMemoryOptimizedEvent);
};

export const setupNightshiftTelemetry = ({
  analytics,
  logger,
}: {
  analytics: Pick<AnalyticsServiceSetup, 'registerEventType' | 'reportEvent'>;
  logger: Logger;
}): NightshiftTelemetryClient => {
  registerNightshiftTelemetryEvents(analytics);
  return new NightshiftTelemetryClient(analytics, logger);
};

export { NightshiftTelemetryClient };
export type { SemanticMemoryMaterializedEvent, SemanticMemoryOptimizedEvent } from './events';
export {
  NIGHTSHIFT_CORTEX_EDIT_APPLIED_EVENT_TYPE,
  NIGHTSHIFT_CORTEX_HYDRATED_EVENT_TYPE,
  type CortexEditAppliedProps,
  type CortexHydratedProps,
} from './cortex_events';
export {
  createCortexTelemetry,
  registerCortexTelemetryEvents,
  type AppliedCortexEdit,
  type CortexTelemetry,
} from './cortex_telemetry';
