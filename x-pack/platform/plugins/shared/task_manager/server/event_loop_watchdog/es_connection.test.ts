/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IElasticsearchConfig } from '@kbn/core-elasticsearch-server';
import { buildWorkerEsConnection } from './es_connection';

const baseConfig = {
  hosts: ['http://localhost:9200'],
  customHeaders: { 'x-custom': 'value' },
  requestTimeout: { asMilliseconds: () => 30000 },
  ssl: {
    verificationMode: 'full',
  },
} as unknown as IElasticsearchConfig;

describe('buildWorkerEsConnection', () => {
  it('maps a service account token to auth, taking priority over basic auth', () => {
    const connection = buildWorkerEsConnection({
      ...baseConfig,
      serviceAccountToken: 'token-value',
      username: 'kibana',
      password: 'changeme',
    });
    expect(connection.auth).toEqual({ type: 'service_account_token', token: 'token-value' });
  });

  it('maps username/password to basic auth', () => {
    const connection = buildWorkerEsConnection({
      ...baseConfig,
      username: 'kibana',
      password: 'changeme',
    });
    expect(connection.auth).toEqual({ type: 'basic', username: 'kibana', password: 'changeme' });
  });

  it('maps no credentials to no auth', () => {
    const connection = buildWorkerEsConnection(baseConfig);
    expect(connection.auth).toEqual({ type: 'none' });
  });

  it('maps ssl verificationMode "none" to rejectUnauthorized false', () => {
    const connection = buildWorkerEsConnection({
      ...baseConfig,
      ssl: { verificationMode: 'none' },
    } as IElasticsearchConfig);
    expect(connection.tls.rejectUnauthorized).toBe(false);
  });

  it('maps ssl verificationMode "full" to rejectUnauthorized true, with ca/cert/key', () => {
    const connection = buildWorkerEsConnection({
      ...baseConfig,
      ssl: {
        verificationMode: 'full',
        certificateAuthorities: ['ca-pem'],
        certificate: 'cert-pem',
        key: 'key-pem',
        keyPassphrase: 'secret',
      },
    } as IElasticsearchConfig);
    expect(connection.tls).toEqual({
      rejectUnauthorized: true,
      ca: ['ca-pem'],
      cert: 'cert-pem',
      key: 'key-pem',
      passphrase: 'secret',
    });
  });

  it('carries nodes, headers and the request timeout through', () => {
    const connection = buildWorkerEsConnection(baseConfig);
    expect(connection.nodes).toEqual(['http://localhost:9200']);
    expect(connection.headers).toEqual({ 'x-custom': 'value' });
    expect(connection.requestTimeoutMs).toBe(30000);
  });
});
