/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { AgentConfigOptions } from 'elastic-apm-node';
import type { TelemetryConfig } from '@kbn/telemetry-config';
import type { MonitoringCollectionConfig } from '@kbn/metrics-config';
import type { ApmConfiguration } from './config';

export interface TelemetryConfiguration {
  environment: Record<string, string>;
  apm: AgentConfigOptions;
  redactUsers: boolean;
  telemetry: TelemetryConfig;
  monitoringCollection: MonitoringCollectionConfig;
}

/** Captures the native resolved instrumentation settings used by this Kibana process. */
export const captureTelemetryConfiguration = (
  configuration: ApmConfiguration,
  serviceName: string
): TelemetryConfiguration => ({
  environment: Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      /^(ELASTIC_APM_|OTEL_)/.test(key) && value !== undefined ? [[key, value]] : []
    )
  ),
  apm: configuration.getConfig(serviceName),
  redactUsers: configuration.isUsersRedactionEnabled(),
  telemetry: configuration.getTelemetryConfig(),
  monitoringCollection: configuration.getMonitoringCollectionConfig(),
});
