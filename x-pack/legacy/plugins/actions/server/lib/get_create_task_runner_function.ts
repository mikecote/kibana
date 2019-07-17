/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { execute } from './execute';
import { ActionTypeRegistryContract, GetServicesFunction } from '../types';
import { TaskInstance } from '../../../task_manager';
import { EncryptedSavedObjectsPlugin } from '../../../encrypted_saved_objects';
import { getApiToken as getAlertApiToken } from '../../../alerting/server/lib/get_api_token';

interface CreateTaskRunnerFunctionOptions {
  getServices: GetServicesFunction;
  actionTypeRegistry: ActionTypeRegistryContract;
  encryptedSavedObjectsPlugin: EncryptedSavedObjectsPlugin;
  spaceIdToNamespace: (spaceId: string) => string;
  getBasePath: (spaceId: string) => string;
}

interface TaskRunnerOptions {
  taskInstance: TaskInstance;
}

export function getCreateTaskRunnerFunction({
  getServices,
  actionTypeRegistry,
  encryptedSavedObjectsPlugin,
  spaceIdToNamespace,
  getBasePath,
}: CreateTaskRunnerFunctionOptions) {
  return ({ taskInstance }: TaskRunnerOptions) => {
    return {
      run: async () => {
        let requestHeaders = {};
        const namespace = spaceIdToNamespace(taskInstance.params.spaceId);

        const { id, actionTypeParams, source } = taskInstance.params;
        if (source.type === 'alert') {
          const apiToken = await getAlertApiToken(
            encryptedSavedObjectsPlugin,
            source.id,
            namespace
          );
          requestHeaders = {
            authorization: `ApiKey ${apiToken}`,
          };
        } else {
          throw new Error(`Invalid source type "${source.type}"`);
        }

        // Since we're using API keys and accessing elasticsearch can only be done
        // via a request, we're faking one with the proper authorization headers.
        const fakeRequest: any = {
          headers: requestHeaders,
          getBasePath: () => getBasePath(taskInstance.params.spaceId),
        };

        await execute({
          namespace,
          actionTypeRegistry,
          encryptedSavedObjectsPlugin,
          actionId: id,
          services: getServices(fakeRequest),
          params: actionTypeParams,
        });
      },
    };
  };
}
