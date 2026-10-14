/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IElasticsearchConfig } from '@kbn/core-elasticsearch-server';
import type { WorkerEsConnection } from './types';

/**
 * PoC only: maps Kibana's own Elasticsearch config (`core.elasticsearch.legacy.config$`, the same
 * one Console and a few other plugins use directly) to the plain, serialisable shape the watchdog
 * worker needs to open its own connection, independent of the main thread's client.
 */
export const buildWorkerEsConnection = (config: IElasticsearchConfig): WorkerEsConnection => ({
  nodes: config.hosts,
  auth: config.serviceAccountToken
    ? { type: 'service_account_token', token: config.serviceAccountToken }
    : config.username !== undefined && config.password !== undefined
    ? { type: 'basic', username: config.username, password: config.password }
    : { type: 'none' },
  tls: {
    rejectUnauthorized: config.ssl.verificationMode !== 'none',
    ca: config.ssl.certificateAuthorities,
    cert: config.ssl.certificate,
    key: config.ssl.key,
    passphrase: config.ssl.keyPassphrase,
  },
  headers: config.customHeaders,
  requestTimeoutMs: config.requestTimeout.asMilliseconds(),
});
