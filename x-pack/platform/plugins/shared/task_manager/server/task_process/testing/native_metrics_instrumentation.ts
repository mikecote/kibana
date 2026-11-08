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

const createInstrumentation = (url?: string): NonNullable<TaskProcessInit['instrumentation']> => ({
  apm: serializeSettings({ active: false, contextPropagationOnly: false }),
  environment: {},
  files: [],
  redactUsers: true,
  telemetry: serializeSettings(
    telemetryConfigSchema.validate({
      tracing: { enabled: false },
      metrics: {
        enabled: url !== undefined,
        interval: '1h',
        exporters:
          url === undefined
            ? []
            : [{ http: { url, temporalityPreference: 'delta', exportTimeout: '5s' } }],
      },
    })
  ),
  monitoringCollection: serializeSettings(
    monitoringCollectionSchema.validate({
      enabled: url === undefined,
      opentelemetry: { metrics: { prometheus: { enabled: url === undefined }, otlp: { url: '' } } },
    })
  ),
});

/** Uses the native delta exporter configuration that Main serializes for process dispatch. */
export const createNativeMetricsInstrumentation = (
  url: string
): NonNullable<TaskProcessInit['instrumentation']> => createInstrumentation(url);

/** Enables the native Prometheus handoff and live gauge readers with no push exporter. */
export const createNativePrometheusInstrumentation = (): NonNullable<
  TaskProcessInit['instrumentation']
> => createInstrumentation();
