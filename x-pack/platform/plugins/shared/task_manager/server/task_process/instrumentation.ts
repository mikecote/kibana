/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import apm from 'elastic-apm-node';
import type { AgentConfigOptions } from 'elastic-apm-node';
import { initApmFromConfiguration } from '@kbn/apm-config-loader';
import type { TelemetryConfiguration } from '@kbn/apm-config-loader';
import { DeltaMetricReader, GaugeMetricReader } from '@kbn/metrics';
import type { ScopeMetrics, MetricResourceSnapshot } from '@kbn/metrics';
import { buildOtelResources, initTelemetryFromConfiguration } from '@kbn/telemetry';
import { diag } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { reviveSettings } from './settings';
import type { TaskProcessInit } from './wire';

export interface TaskProcessInstrumentation {
  forceFlush: () => Promise<void>;
  collectMetrics?: () => Promise<ScopeMetrics[]>;
  collectGauges?: () => Promise<MetricResourceSnapshot[]>;
  shutdown: () => Promise<void>;
}

/** Starts native instrumentation before task modules load using Main's resolved configuration. */
export const initializeTaskProcessInstrumentation = async (
  serialized: NonNullable<TaskProcessInit['instrumentation']>
): Promise<TaskProcessInstrumentation> => {
  const configuration: TelemetryConfiguration = {
    files: serialized.files,
    environment: serialized.environment,
    apm: reviveSettings(serialized.apm) as AgentConfigOptions,
    redactUsers: serialized.redactUsers,
    telemetry: reviveSettings(serialized.telemetry) as TelemetryConfiguration['telemetry'],
    monitoringCollection: reviveSettings(
      serialized.monitoringCollection
    ) as TelemetryConfiguration['monitoringCollection'],
  };
  const prometheusReader =
    configuration.telemetry.enabled &&
    configuration.monitoringCollection.enabled &&
    configuration.monitoringCollection.opentelemetry.metrics.prometheus.enabled
      ? new DeltaMetricReader()
      : undefined;
  const gaugeReader = prometheusReader ? new GaugeMetricReader() : undefined;
  const serviceName = configuration.apm.serviceName ?? 'kibana';
  initApmFromConfiguration(configuration.apm, configuration.redactUsers, serviceName);
  const telemetry = initTelemetryFromConfiguration(
    configuration,
    () =>
      buildOtelResources(serviceName, configuration.apm).merge(
        resourceFromAttributes({ 'service.instance.id': randomUUID() })
      ),
    { prometheusReader, additionalReaders: gaugeReader ? [gaugeReader] : [] }
  );
  await telemetry.ready;
  const forceFlush = async (): Promise<void> => {
    await Promise.all([telemetry.forceFlush(), apm.isStarted() ? apm.flush() : Promise.resolve()]);
  };
  let shutdownPromise: Promise<void> | undefined;
  return {
    forceFlush,
    collectGauges: gaugeReader
      ? async () => {
          const { resourceMetrics, errors } = await gaugeReader.collect({ timeoutMillis: 5000 });
          if (errors.length)
            throw new AggregateError(errors, 'Native worker gauge collection failed');
          return [
            {
              resourceAttributes: resourceMetrics.resource.attributes,
              scopeMetrics: resourceMetrics.scopeMetrics,
            },
          ];
        }
      : undefined,
    collectMetrics: prometheusReader
      ? async () => {
          const { resourceMetrics, errors } = await prometheusReader.collect({
            timeoutMillis: 5000,
          });
          if (errors.length) diag.warn('Native worker metric collection errors', ...errors);
          return resourceMetrics.scopeMetrics;
        }
      : undefined,
    shutdown: () =>
      (shutdownPromise ??= (async () => {
        await forceFlush();
        await telemetry.shutdown();
        if (apm.isStarted()) await apm.destroy();
      })()),
  };
};
