/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CapabilitiesSwitcher, KibanaRequest, Logger } from '@kbn/core/server';
import type { ElasticsearchFeature, KibanaFeature } from '@kbn/features-plugin/server';
import type { AuthorizationServiceSetup } from '@kbn/security-plugin-types-server';

import { disableUICapabilitiesFactory } from './disable_ui_capabilities';
import type { AuthenticatedUser } from '../../common';

interface SecurityCapabilitiesServices {
  authz: Pick<
    AuthorizationServiceSetup,
    'actions' | 'checkPrivilegesDynamicallyWithRequest' | 'mode'
  >;
  getKibanaFeatures: () => KibanaFeature[];
  getElasticsearchFeatures: () => ElasticsearchFeature[];
  getCurrentUser: (request: KibanaRequest) => AuthenticatedUser | null;
  logger: Logger;
}

/** Resolves feature capabilities with native authorization for HTTP and credential-bearing task requests. */
export const createSecurityCapabilitiesSwitcher =
  ({
    authz,
    getKibanaFeatures,
    getElasticsearchFeatures,
    getCurrentUser,
    logger,
  }: SecurityCapabilitiesServices): CapabilitiesSwitcher =>
  async (request, capabilities) => {
    if (!authz.mode.useRbacForRequest(request)) return {};

    const disable = disableUICapabilitiesFactory(
      request,
      getKibanaFeatures(),
      getElasticsearchFeatures(),
      logger,
      authz,
      getCurrentUser(request)
    );
    const credentials = request.headers.authorization;
    const hasTaskCredentials =
      request.isFakeRequest && typeof credentials === 'string' && credentials.length > 0;
    if (!request.auth.isAuthenticated && !hasTaskCredentials) {
      return disable.all(capabilities);
    }

    return disable.usingPrivileges(capabilities);
  };
