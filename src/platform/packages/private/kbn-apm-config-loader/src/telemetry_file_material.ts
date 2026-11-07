/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readFileSync, statSync } from 'node:fs';
import type { TelemetryConfiguration } from './telemetry_configuration';

type OtlpSignal = 'TRACES' | 'METRICS' | 'LOGS';
type OtlpCertificateKind = 'CERTIFICATE' | 'CLIENT_CERTIFICATE' | 'CLIENT_KEY';
export type TelemetryEnvironmentFileKey =
  | 'ELASTIC_APM_SERVER_CA_CERT_FILE'
  | `OTEL_EXPORTER_OTLP_${OtlpCertificateKind}`
  | `OTEL_EXPORTER_OTLP_${OtlpSignal}_${OtlpCertificateKind}`;

export interface TelemetryFileMaterial {
  target:
    | { kind: 'apm'; key: 'serverCaCertFile' }
    | { kind: 'environment'; key: TelemetryEnvironmentFileKey };
  /** Null records unavailable portable file contents. */
  data: string | null;
}

/** Recognizes only native instrumentation certificate settings. */
export const isTelemetryEnvironmentFileKey = (key: string): key is TelemetryEnvironmentFileKey =>
  /^(ELASTIC_APM_SERVER_CA_CERT_FILE|OTEL_EXPORTER_OTLP(_(TRACES|METRICS|LOGS))?_(CERTIFICATE|CLIENT_CERTIFICATE|CLIENT_KEY))$/.test(
    key
  );

/** Captures certificate bytes using the native SDK's environment precedence. */
export const captureTelemetryFileMaterial = (
  configuration: Pick<TelemetryConfiguration, 'apm' | 'environment'>
): TelemetryFileMaterial[] => {
  const { environment, apm } = configuration;
  const material: TelemetryFileMaterial[] = [];
  const capture = (target: TelemetryFileMaterial['target'], path: string): void => {
    let data: string | null;
    try {
      data = statSync(path).isFile() ? readFileSync(path).toString('base64') : null;
    } catch {
      data = null;
    }
    material.push({ target, data });
  };
  const apmEnvironmentPath = environment.ELASTIC_APM_SERVER_CA_CERT_FILE;
  if (apmEnvironmentPath !== undefined) {
    capture({ kind: 'environment', key: 'ELASTIC_APM_SERVER_CA_CERT_FILE' }, apmEnvironmentPath);
  } else if (typeof apm.serverCaCertFile === 'string') {
    capture({ kind: 'apm', key: 'serverCaCertFile' }, apm.serverCaCertFile);
  }
  const seen = new Set<TelemetryEnvironmentFileKey>();
  for (const signal of ['TRACES', 'METRICS', 'LOGS'] as const) {
    for (const kind of ['CERTIFICATE', 'CLIENT_CERTIFICATE', 'CLIENT_KEY'] as const) {
      const specific = `OTEL_EXPORTER_OTLP_${signal}_${kind}` as const;
      const general = `OTEL_EXPORTER_OTLP_${kind}` as const;
      const key = environment[specific] !== undefined ? specific : general;
      const path = environment[key];
      if (path === undefined || seen.has(key)) continue;
      seen.add(key);
      capture({ kind: 'environment', key }, path);
    }
  }
  return material;
};
