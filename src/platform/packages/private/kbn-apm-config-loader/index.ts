/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export {
  getConfiguration,
  getTelemetryConfiguration,
  loadConfiguration,
} from './src/config_loader';
export { initApm, initApmFromConfiguration } from './src/init_apm';
export { shouldInstrumentClient } from './src/rum_agent_configuration';
export type { ApmConfiguration } from './src/config';
export { apmConfigSchema } from './src/apm_config';

export { captureTelemetryConfiguration } from './src/telemetry_configuration';
export type { TelemetryConfiguration } from './src/telemetry_configuration';

export {
  captureTelemetryFileMaterial,
  isTelemetryEnvironmentFileKey,
} from './src/telemetry_file_material';
export type {
  TelemetryFileMaterial,
  TelemetryEnvironmentFileKey,
} from './src/telemetry_file_material';
