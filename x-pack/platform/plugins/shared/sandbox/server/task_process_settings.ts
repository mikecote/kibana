/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SandboxPluginConfig } from './config';
import type { SandboxTlsCredentials } from './tls_credentials';

export const SANDBOX_TASK_PROCESS_SETTINGS_ID = 'sandboxRuntime';

export interface SandboxTaskProcessSettings {
  config: Pick<SandboxPluginConfig, 'enabled' | 'host' | 'port' | 'api_key'>;
  spacesEnabled: boolean;
  tlsCredentials?: {
    rootCertPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
  };
}

/** Captures the credentials the native Main client uses without transporting local file paths. */
export const getSandboxTaskProcessSettings = (
  { enabled, host, port, api_key: apiKey }: SandboxPluginConfig,
  credentials?: SandboxTlsCredentials,
  spacesEnabled: boolean = false
): SandboxTaskProcessSettings => ({
  config: { enabled, host, port, api_key: apiKey },
  spacesEnabled,
  tlsCredentials: credentials
    ? {
        rootCertPem: credentials.rootCertPem?.toString('base64'),
        clientCertPem: credentials.clientCertPem?.toString('base64'),
        clientKeyPem: credentials.clientKeyPem?.toString('base64'),
      }
    : undefined,
});

/** Restores the exact PEM bytes used by Main for the native gRPC client. */
export const restoreSandboxTlsCredentials = (
  credentials: SandboxTaskProcessSettings['tlsCredentials']
): SandboxTlsCredentials | undefined =>
  credentials
    ? {
        rootCertPem: credentials.rootCertPem
          ? Buffer.from(credentials.rootCertPem, 'base64')
          : undefined,
        clientCertPem: credentials.clientCertPem
          ? Buffer.from(credentials.clientCertPem, 'base64')
          : undefined,
        clientKeyPem: credentials.clientKeyPem
          ? Buffer.from(credentials.clientKeyPem, 'base64')
          : undefined,
      }
    : undefined;
