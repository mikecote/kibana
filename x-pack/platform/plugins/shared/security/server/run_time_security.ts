/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BuildFlavor } from '@kbn/config';
import type { IClusterClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { KibanaFeature } from '@kbn/features-plugin/server';
import { Actions } from '@kbn/security-authorization-core';
import type { AuditServiceSetup } from '@kbn/security-plugin-types-server';

import { createApiKeys } from './authentication/api_keys/create_api_keys';
import type { InternalAuthenticationServiceStart } from './authentication/authentication_service';
import { checkPrivilegesFactory } from './authorization/check_privileges';
import { checkPrivilegesDynamicallyWithRequestFactory } from './authorization/check_privileges_dynamically';
import { checkSavedObjectsPrivilegesWithRequestFactory } from './authorization/check_saved_objects_privileges';
import { authorizationModeFactory } from './authorization/mode';
import type { UiamConfigType } from './config';
import type { SpacesService } from './plugin';
import { UiamService } from './uiam/uiam_service';
import type { AuthenticatedUser, SecurityLicense } from '../common';

export interface RunTimeSecurityOptions {
  logger: Pick<Logger, 'get'>;
  clusterClient: IClusterClient;
  license: SecurityLicense;
  config: {
    uiam?: UiamConfigType;
    serviceAccounts: { enabled: boolean };
  };
  /** The application the Kibana privileges are registered under in Elasticsearch. */
  applicationName: string;
  buildFlavor?: BuildFlavor;
  /** Needed to validate the Kibana privileges of the role descriptors of an API key. */
  kibanaFeatures?: KibanaFeature[];
  /** What the UIAM service needs besides its config. Required when `config.uiam.enabled`. */
  uiam?: {
    kibanaServerResourceURL: string;
    elasticsearchUrl?: string;
    kibanaVersion: string;
  };
  audit: AuditServiceSetup;
  /** Who a request acts for: Kibana's authenticated user, or what enriches a fake request. */
  getCurrentUser: (request: KibanaRequest) => AuthenticatedUser | null;
}

export interface RunTimeSecurity {
  authc: Pick<InternalAuthenticationServiceStart, 'apiKeys' | 'getCurrentUser'>;
  authz: ReturnType<typeof checkPrivilegesFactory> & {
    /**
     * Checks at the space of the request (a run's fake request names its space), as the actions
     * plugin does for connectors.
     */
    checkPrivilegesDynamicallyWithRequest: ReturnType<
      typeof checkPrivilegesDynamicallyWithRequestFactory
    >;
    actions: Actions;
    applicationName: string;
    /** Whether the privileges of a request are checked, which the license decides. */
    mode: ReturnType<typeof authorizationModeFactory>;
    checkSavedObjectsPrivilegesWithRequest: ReturnType<
      typeof checkSavedObjectsPrivilegesWithRequestFactory
    >;
  };
  audit: AuditServiceSetup;
}

/**
 * What a run needs of the security plugin, with its dependencies explicit: API keys (including
 * UIAM API keys), privilege checks and the audit log. It is built from the same constructors the
 * plugin's authentication and authorization services use, so Kibana and a task process behave alike.
 */
export const createRunTimeSecurity = ({
  logger,
  clusterClient,
  license,
  config,
  applicationName,
  buildFlavor = 'traditional',
  kibanaFeatures = [],
  uiam: uiamOptions,
  audit,
  getCurrentUser,
}: RunTimeSecurityOptions): RunTimeSecurity => {
  let uiam: UiamService | undefined;
  if (config.uiam?.enabled) {
    if (!uiamOptions) throw new Error('UIAM is enabled but its server options were not given');
    uiam = new UiamService(logger.get('uiam'), config.uiam, uiamOptions);
  }

  const apiKeys = createApiKeys({
    loggerFactory: logger,
    clusterClient,
    license,
    applicationName,
    kibanaFeatures,
    buildFlavor,
    uiam,
    serviceAccountsEnabled: config.serviceAccounts.enabled,
    getCurrentUser,
  });

  const actions = new Actions();
  const privileges = checkPrivilegesFactory(actions, async () => clusterClient, applicationName);

  // Spaces are always on in a task process, and a namespace is the id of its space but for the default.
  const spacesService = {
    namespaceToSpaceId: (namespace?: string) => namespace ?? 'default',
    // The space of a run is the one its fake request names.
    getSpaceId: (request: KibanaRequest) =>
      (request as unknown as { spaceId?: string }).spaceId ?? 'default',
  } as unknown as SpacesService;

  return {
    authc: { apiKeys, getCurrentUser },
    authz: {
      ...privileges,
      actions,
      applicationName,
      mode: authorizationModeFactory(license),
      checkSavedObjectsPrivilegesWithRequest: checkSavedObjectsPrivilegesWithRequestFactory(
        privileges.checkPrivilegesWithRequest,
        () => spacesService
      ),
      checkPrivilegesDynamicallyWithRequest: checkPrivilegesDynamicallyWithRequestFactory(
        privileges.checkPrivilegesWithRequest,
        () => spacesService
      ),
    },
    audit,
  };
};
