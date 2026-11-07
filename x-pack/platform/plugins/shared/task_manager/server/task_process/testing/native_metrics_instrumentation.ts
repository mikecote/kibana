/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { monitoringCollectionSchema } from '@kbn/metrics-config';
import { telemetryConfigSchema } from '@kbn/telemetry-config';
import { serializeSettings } from '../settings';
import type { TaskProcessInit } from '../wire';

/** Uses the native delta exporter configuration that Main serializes for process dispatch. */
export const createNativeMetricsInstrumentation = (
  url: string
): NonNullable<TaskProcessInit['instrumentation']> => ({
  apm: serializeSettings({ active: false, contextPropagationOnly: false }),
  environment: {},
  files: [],
  redactUsers: true,
  telemetry: serializeSettings(
    telemetryConfigSchema.validate({
      tracing: { enabled: false },
      metrics: {
        enabled: true,
        interval: '1h',
        exporters: [{ http: { url, temporalityPreference: 'delta', exportTimeout: '5s' } }],
      },
    })
  ),
  monitoringCollection: serializeSettings(monitoringCollectionSchema.validate({ enabled: false })),
});
