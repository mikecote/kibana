/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { isExternalUiamCredential } from '@kbn/core-security-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { CasesClient } from '../client';
import type { GetCasesClientOptions } from '../client/types';
import { CasesOperationsToken, casesOperationBindings } from './cases_operations_api';

/** Preserves the native step handlers, forwarding only their enumerated client calls. */
export const createCoordinatorCasesClient = (
  host: TaskHost,
  request: KibanaRequest,
  options?: GetCasesClientOptions
): CasesClient => {
  const withCapability = host.withCoordinatorCapability;
  if (!withCapability) throw new Error('Cases coordinator placement is unavailable');
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('ApiKey '))
    throw new Error('Cases requires the resolved workflow API key');
  const user = host.security.authc.getCurrentUser(request);
  const identity = {
    apiKey: authorization.slice('ApiKey '.length),
    spaceId: request.spaceId,
    userName: user?.username,
    userProfileId: user?.profile_uid,
    uiamApiKeyExternal: isExternalUiamCredential(request),
  };
  const client: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [operation, [namespace, method]] of Object.entries(casesOperationBindings)) {
    client[namespace] ??= {};
    client[namespace][method] = (...args) =>
      withCapability(CasesOperationsToken, async (capability) => {
        const name = operation as keyof typeof casesOperationBindings;
        const response = Reflect.apply(capability[name], capability, [
          identity,
          options,
          ...args,
        ]) as Promise<unknown> & Disposable;
        try {
          return await response;
        } finally {
          response[Symbol.dispose]();
        }
      });
  }
  // CasesClient's private implementation fields stay on Main; only the enumerated public methods are used here.
  return client as unknown as CasesClient;
};
