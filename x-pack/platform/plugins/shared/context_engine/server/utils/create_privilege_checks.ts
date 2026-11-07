/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { apiPrivileges } from '../../common/features';

/**
 * The privilege checks of the steps, built from the security authorization service: Kibana reads it
 * from the security plugin's start contract, and a task process from the security task plugin.
 * Without security (it is optional at start) every check passes.
 */
export const createPrivilegeChecks = ({
  getAuthz,
}: {
  getAuthz: () => Promise<SecurityPluginStart['authz'] | undefined>;
}) => {
  const checkApiPrivileges = async (
    request: KibanaRequest,
    spaceId: string,
    actions: readonly string[]
  ): Promise<boolean> => {
    const authz = await getAuthz();
    if (!authz) {
      return true;
    }
    const { hasAllRequested } = await authz.checkPrivilegesWithRequest(request).atSpace(spaceId, {
      kibana: actions.map((action) => authz.actions.api.get(action)),
    });
    return hasAllRequested;
  };

  const checkWritePrivilege = (request: KibanaRequest, spaceId: string) =>
    checkApiPrivileges(request, spaceId, [apiPrivileges.writeContextEngine]);

  return { checkApiPrivileges, checkWritePrivilege };
};
