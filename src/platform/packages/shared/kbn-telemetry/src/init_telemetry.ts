/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */
import { captureTelemetryConfiguration, loadConfiguration } from '@kbn/apm-config-loader';
import { buildOtelResources } from './build_otel_resources';
import { initTelemetryFromConfiguration } from './init_telemetry_from_configuration';
import type { TelemetryLifecycle } from './init_telemetry_from_configuration';

/** Initializes native telemetry from Kibana's configuration files and environment. */
export const initTelemetry = (
  argv: string[],
  rootDir: string,
  isDistributable: boolean,
  serviceName: string
): TelemetryLifecycle => {
  const configuration = loadConfiguration(argv, rootDir, isDistributable);
  return initTelemetryFromConfiguration(
    captureTelemetryConfiguration(configuration, serviceName),
    () => buildOtelResources(serviceName)
  );
};
