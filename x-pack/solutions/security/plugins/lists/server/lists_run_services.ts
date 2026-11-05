/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';

import type { ConfigType } from './config';
import { ListClient } from './services/lists/list_client';
import { ExceptionListClient } from './services/exception_lists/exception_list_client';
import type { ExtensionPointStorageClientInterface } from './services/extension_points';
import { ExtensionPointStorage } from './services/extension_points';
import type { ListPluginSetup } from './types';

/** The id of the plugin's settings in a task process, `host.settings[id]`. */
export const LISTS_TASK_PROCESS_SETTINGS_ID = 'lists';

/** The clients of lists and exceptions that rule types use, which are plain clients over Elasticsearch. */
export type ListsRunServices = Pick<ListPluginSetup, 'getExceptionListClient' | 'getListClient'>;

/**
 * The list and exception list clients, built from explicit dependencies: Kibana builds them with its
 * server extension points registry, a task process with an empty one (see
 * `createListsTaskProcessServices`).
 */
export const createListsRunServices = ({
  config,
  getServerExtensionsClient,
}: {
  config: ConfigType;
  getServerExtensionsClient: () => ExtensionPointStorageClientInterface;
}): ListsRunServices => ({
  getExceptionListClient: (
    savedObjectsClient,
    user,
    enableServerExtensionPoints = true
  ): ExceptionListClient =>
    new ExceptionListClient({
      enableServerExtensionPoints,
      savedObjectsClient,
      serverExtensionsClient: getServerExtensionsClient(),
      user,
    }),
  getListClient: (esClient, spaceId, user): ListClient =>
    new ListClient({
      config,
      esClient,
      spaceId,
      user,
    }),
});

/**
 * The same clients for a task process, with the config Kibana sent. The extensions other plugins
 * register with the lists plugin run in Kibana, on requests of users (they validate who writes
 * which list); a rule run reads lists on behalf of no request, so none apply.
 */
export const createListsTaskProcessServices = ({
  settings,
  logger,
}: {
  settings: Record<string, unknown>;
  logger: Logger;
}): ListsRunServices => {
  const config = settings[LISTS_TASK_PROCESS_SETTINGS_ID] as ConfigType | undefined;
  if (!config) {
    throw new Error(
      `The task process was not given the settings of ${LISTS_TASK_PROCESS_SETTINGS_ID}`
    );
  }
  const noExtensions = new ExtensionPointStorage(logger);
  return createListsRunServices({
    config,
    getServerExtensionsClient: () => noExtensions.getClient(),
  });
};
