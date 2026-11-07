/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureTelemetryFileMaterial } from '@kbn/apm-config-loader';
import type { TelemetryConfiguration } from '@kbn/apm-config-loader';
import { createPrivateTemporaryDirectory } from '@kbn/fs';
import { monitoringCollectionSchema } from '@kbn/metrics-config';
import { REPO_ROOT } from '@kbn/repo-info';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import type { TaskProcessInit } from '@kbn/task-manager-plugin/server/task_process/wire';
import { telemetryConfigSchema } from '@kbn/telemetry-config';

interface TraceTlsSources {
  paths: { ca: string; certificate: string; key: string };
  server: { ca: string; cert: string; key: string };
  cleanup: () => void;
}

/** Creates Main's certificate files independently of the collector's retained TLS material. */
export const createTraceTlsSources = (): TraceTlsSources => {
  const directory = createPrivateTemporaryDirectory('task-trace-main-certificates-');
  const certificates = join(REPO_ROOT, 'src/platform/packages/shared/kbn-dev-utils/certs');
  const read = (name: string): string => readFileSync(join(certificates, name), 'utf8');
  const write = directory.writeFile;
  return {
    paths: {
      ca: write('ca.pem', read('ca.crt')),
      certificate: write('client.pem', read('relay.crt')),
      key: write('client.key', read('relay.key')),
    },
    server: { ca: read('ca.crt'), cert: read('kibana.crt'), key: read('kibana.key') },
    cleanup: directory.cleanup,
  };
};

/** Captures native SDK configuration and file bytes using the same factory as Main dispatch. */
export const createTraceInstrumentation = (
  backend: 'apm' | 'otel',
  url: string,
  paths?: TraceTlsSources['paths'],
  specific: boolean = false
): NonNullable<TaskProcessInit['instrumentation']> => {
  const configuration: Omit<TelemetryConfiguration, 'files'> = {
    apm: {
      active: backend === 'apm',
      contextPropagationOnly: false,
      serviceName: 'kibana',
      serviceVersion: '9.6.0',
      serverUrl: url,
      centralConfig: false,
      cloudProvider: 'none',
      captureExceptions: false,
      transactionSampleRate: 1,
      metricsInterval: '0s',
      logLevel: 'off',
    },
    environment: { OTEL_RESOURCE_ATTRIBUTES: 'parity.native=from-main' },
    redactUsers: true,
    telemetry: telemetryConfigSchema.validate({
      tracing: {
        enabled: backend === 'otel',
        sample_rate: 1,
        exporters: [{ http: { url: `${url}/v1/traces` } }],
      },
    }),
    monitoringCollection: monitoringCollectionSchema.validate({ enabled: false }),
  };
  if (paths && backend === 'apm') {
    configuration.apm.serverCaCertFile = specific ? `${paths.ca}.unused` : paths.ca;
    if (specific) configuration.environment.ELASTIC_APM_SERVER_CA_CERT_FILE = paths.ca;
  }
  if (paths && backend === 'otel') {
    const suffix = specific ? '.unused' : '';
    Object.assign(configuration.environment, {
      OTEL_EXPORTER_OTLP_CERTIFICATE: `${paths.ca}${suffix}`,
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: `${paths.certificate}${suffix}`,
      OTEL_EXPORTER_OTLP_CLIENT_KEY: `${paths.key}${suffix}`,
    });
    if (specific)
      Object.assign(configuration.environment, {
        OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: paths.ca,
        OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE: paths.certificate,
        OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: paths.key,
      });
  }
  return {
    ...configuration,
    files: captureTelemetryFileMaterial(configuration),
    apm: serializeSettings(configuration.apm),
    telemetry: serializeSettings(configuration.telemetry),
    monitoringCollection: serializeSettings(configuration.monitoringCollection),
  };
};
