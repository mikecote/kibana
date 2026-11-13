/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTelemetryFileMaterial } from './telemetry_file_material';

describe('native instrumentation certificate capture', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'native-instrumentation-files-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('preserves binary certificate bytes and the native APM environment precedence', () => {
    const certificate = join(directory, 'certificate.pem');
    const contents = Buffer.from([0, 255, 10, 65]);
    writeFileSync(certificate, contents);
    expect(
      captureTelemetryFileMaterial({
        apm: { serverCaCertFile: join(directory, 'ignored.pem') },
        environment: { ELASTIC_APM_SERVER_CA_CERT_FILE: certificate },
      })
    ).toEqual([
      {
        target: { kind: 'environment', key: 'ELASTIC_APM_SERVER_CA_CERT_FILE' },
        data: contents.toString('base64'),
      },
    ]);
    expect(
      captureTelemetryFileMaterial({ apm: { serverCaCertFile: certificate }, environment: {} })
    ).toEqual([
      { target: { kind: 'apm', key: 'serverCaCertFile' }, data: contents.toString('base64') },
    ]);
  });

  it('captures signal-specific TLS material and records unreadable global settings for other signals', () => {
    const certificate = join(directory, 'trace-ca.pem');
    writeFileSync(certificate, 'trace certificate');
    expect(
      captureTelemetryFileMaterial({
        apm: {},
        environment: {
          OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: certificate,
          OTEL_EXPORTER_OTLP_CERTIFICATE: join(directory, 'missing.pem'),
        },
      })
    ).toEqual([
      {
        target: { kind: 'environment', key: 'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE' },
        data: Buffer.from('trace certificate').toString('base64'),
      },
      { target: { kind: 'environment', key: 'OTEL_EXPORTER_OTLP_CERTIFICATE' }, data: null },
    ]);
  });

  it('does not attempt to read non-regular files', () => {
    expect(
      captureTelemetryFileMaterial({ apm: { serverCaCertFile: directory }, environment: {} })
    ).toEqual([{ target: { kind: 'apm', key: 'serverCaCertFile' }, data: null }]);
  });
});
