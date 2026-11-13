/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SandboxPluginConfig } from './config';
import type { SandboxPluginStart } from './plugin';
import { SandboxApiClient } from './grpc_client';
import { SandboxSessionImpl } from './sandbox_session';
import type { SandboxSession } from './sandbox_session';
import type { SandboxTlsCredentials } from './tls_credentials';

export interface SandboxRunServices {
  sandbox: SandboxPluginStart;
  stop: () => void;
}

/** Creates the native sandbox client and space-scoped sessions used by Main and task processes. */
export const createSandboxRunServices = ({
  config,
  tlsCredentials,
  spaces,
  logger,
}: {
  config: Pick<SandboxPluginConfig, 'enabled' | 'host' | 'port' | 'api_key'>;
  tlsCredentials?: SandboxTlsCredentials;
  spaces?: Pick<SpacesPluginStart['spacesService'], 'getSpaceId'>;
  logger: Logger;
}): SandboxRunServices => {
  if (config.enabled && config.api_key && !tlsCredentials) {
    throw new Error('Native Sandbox requires the TLS credential snapshot used by Main');
  }
  if (!config.enabled || !config.api_key) {
    if (config.enabled) {
      logger.warn(
        'xpack.sandbox.enabled is true but api_key is not configured — sandbox is disabled'
      );
    }
    const reason = !config.enabled
      ? 'xpack.sandbox.enabled is false'
      : 'xpack.sandbox.api_key is required when enabled';
    const throwNotConfigured = (): never => {
      throw new Error(`Sandbox is not configured in this deployment: ${reason}`);
    };
    return {
      sandbox: { getSession: throwNotConfigured, getSessionForSpace: throwNotConfigured },
      stop: () => {},
    };
  }

  const apiClient = new SandboxApiClient({
    host: config.host,
    port: config.port,
    apiKey: config.api_key,
    ...tlsCredentials,
  });
  const sessions = new Map<string, SandboxSession>();
  const getOrCreateSession = (spaceId: string, sessionId: string): SandboxSession => {
    const cacheKey = `${spaceId}:${sessionId}`;
    let session = sessions.get(cacheKey);
    if (!session) {
      session = new SandboxSessionImpl(
        `${spaceId}__${sessionId}`,
        apiClient,
        logger.get('session')
      );
      sessions.set(cacheKey, session);
    }
    return session;
  };
  return {
    sandbox: {
      getSession: (request, sessionId) =>
        getOrCreateSession(spaces?.getSpaceId(request) ?? DEFAULT_SPACE_ID, sessionId),
      getSessionForSpace: getOrCreateSession,
    },
    stop: () => {
      apiClient.close();
      sessions.clear();
    },
  };
};
