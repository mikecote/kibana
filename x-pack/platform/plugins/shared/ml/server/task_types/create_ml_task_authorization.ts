/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { MlAuthorizationService } from '../lib/capabilities/check_capabilities';

/** Resolves native authorization lazily so ML registrations need no running execution services. */
export const createMlTaskAuthorization = (
  host: Pick<TaskHost, 'plugins'>
): MlAuthorizationService => {
  const getAuthorization = () => {
    const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
    if (!security) throw new Error('ML execution requires the native Security service');
    return security.authz;
  };
  return {
    get actions() {
      return getAuthorization().actions;
    },
    get mode() {
      return getAuthorization().mode;
    },
    checkPrivilegesWithRequest: (request) => getAuthorization().checkPrivilegesWithRequest(request),
    checkPrivilegesDynamicallyWithRequest: (request) =>
      getAuthorization().checkPrivilegesDynamicallyWithRequest(request),
  };
};
