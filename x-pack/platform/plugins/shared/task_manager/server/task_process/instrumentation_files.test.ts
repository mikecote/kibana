/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { AgentConfigOptions } from 'elastic-apm-node';
import { materializeTaskProcessInstrumentationFiles } from './instrumentation_files';
import { reviveSettings, serializeSettings } from './settings';

it('gives the native SDK private certificate files and removes them after shutdown', () => {
  const material = materializeTaskProcessInstrumentationFiles({
    apm: serializeSettings({ serverCaCertFile: '/main/ca.pem' }),
    environment: {
      OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: '/main/client.key',
      OTEL_RESOURCE_ATTRIBUTES: 'proof=main',
    },
    files: [
      {
        target: { kind: 'apm', key: 'serverCaCertFile' },
        data: Buffer.from('CA bytes').toString('base64'),
      },
      {
        target: { kind: 'environment', key: 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY' },
        data: Buffer.from('private key bytes').toString('base64'),
      },
    ],
  });
  const apm = reviveSettings(material.instrumentation.apm) as AgentConfigOptions;
  const ca = apm.serverCaCertFile;
  if (!ca) throw new Error('The native CA path was not materialized');
  const key = material.instrumentation.environment.OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY;
  try {
    expect(ca).not.toBe('/main/ca.pem');
    expect(key).not.toBe('/main/client.key');
    expect(readFileSync(ca, 'utf8')).toBe('CA bytes');
    expect(readFileSync(key, 'utf8')).toBe('private key bytes');
    expect(statSync(key).mode.toString(8).slice(-3)).toBe('600');
    expect(material.instrumentation.environment.OTEL_RESOURCE_ATTRIBUTES).toBe('proof=main');
  } finally {
    material.cleanup();
  }
  expect(existsSync(ca)).toBe(false);
  expect(existsSync(key)).toBe(false);
});

it('preserves an unreadable Main file without using a worker-local file at the original path', () => {
  const material = materializeTaskProcessInstrumentationFiles({
    apm: serializeSettings({}),
    environment: { OTEL_EXPORTER_OTLP_CERTIFICATE: __filename },
    files: [{ target: { kind: 'environment', key: 'OTEL_EXPORTER_OTLP_CERTIFICATE' }, data: null }],
  });
  try {
    const path = material.instrumentation.environment.OTEL_EXPORTER_OTLP_CERTIFICATE;
    expect(path).not.toBe(__filename);
    expect(existsSync(path)).toBe(false);
  } finally {
    material.cleanup();
  }
});
