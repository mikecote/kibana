/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';

import type { ConstructorOptions } from './api_keys';
import { APIKeys } from './api_keys';
import { UiamAPIKeys } from './uiam/uiam_api_keys';
import type { InternalAuthenticationServiceStart } from '../authentication_service';

export type CreateApiKeysOptions = Omit<ConstructorOptions, 'logger'> & {
  /** Where the API keys and UIAM API keys loggers come from. */
  loggerFactory: Pick<Logger, 'get'>;
};

/**
 * The API keys API Core exposes (`core.security.authc.apiKeys`), with the UIAM API keys when a UIAM
 * service is given. It is built the same way in Kibana and in a task process, so a run creates,
 * clones, grants and invalidates API keys exactly as the plugin does.
 */
export const createApiKeys = ({
  loggerFactory,
  ...options
}: CreateApiKeysOptions): InternalAuthenticationServiceStart['apiKeys'] => {
  const apiKeys = new APIKeys({ ...options, logger: loggerFactory.get('api-key') });
  const uiamAPIKeys = options.uiam
    ? new UiamAPIKeys({
        logger: loggerFactory.get('api-key-uiam'),
        license: options.license,
        uiam: options.uiam,
        getCurrentUser: options.getCurrentUser ?? (() => null),
      })
    : null;

  return {
    areAPIKeysEnabled: apiKeys.areAPIKeysEnabled.bind(apiKeys),
    areCrossClusterAPIKeysEnabled: apiKeys.areCrossClusterAPIKeysEnabled.bind(apiKeys),
    create: apiKeys.create.bind(apiKeys),
    update: apiKeys.update.bind(apiKeys),
    grantAsInternalUser: apiKeys.grantAsInternalUser.bind(apiKeys),
    cloneAsInternalUser: apiKeys.cloneAsInternalUser.bind(apiKeys),
    invalidate: apiKeys.invalidate.bind(apiKeys),
    validate: apiKeys.validate.bind(apiKeys),
    invalidateAsInternalUser: apiKeys.invalidateAsInternalUser.bind(apiKeys),
    uiam: uiamAPIKeys
      ? {
          grant: uiamAPIKeys.grant.bind(uiamAPIKeys),
          invalidate: uiamAPIKeys.invalidate.bind(uiamAPIKeys),
          convert: uiamAPIKeys.convert.bind(uiamAPIKeys),
          getInternalCallerAttestationHeaders:
            uiamAPIKeys.getInternalCallerAttestationHeaders.bind(uiamAPIKeys),
          isOwnClientAuthentication: uiamAPIKeys.isOwnClientAuthentication.bind(uiamAPIKeys),
          isExternalApiKey: uiamAPIKeys.isExternalApiKey.bind(uiamAPIKeys),
        }
      : null,
  };
};
