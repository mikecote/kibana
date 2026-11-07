/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, ISavedObjectsRepository, Logger } from '@kbn/core/server';
import { SavedObjectsClient } from '@kbn/core/server';
import { ProductDocInstallClient } from './services/doc_install_status';
import { getOverallStatus } from './services/doc_manager/doc_manager';
import { SearchService } from './services/search';
import type { SearchApi } from './services/search';
import { productDocInstallStatusSavedObjectType } from './saved_objects';

/** The saved object type the install status is read from: a process declares it. */
export const productDocReadSavedObjectTypes = [productDocInstallStatusSavedObjectType];

/**
 * What reading the product documentation takes (search it, and whether it is installed), built from
 * explicit dependencies: a task process builds it from its host, where Kibana's plugin has the
 * installer and the tasks that install. Installing and updating the documentation stays Kibana's.
 *
 * Differences from the plugin's `getStatus`: an installation task in flight is not looked at (the
 * documentation counts as installed once every product is, as the status saved objects say), and the
 * status of Security Labs, which needs the package installer, is not available.
 */
export const createProductDocReadServices = ({
  esClient,
  createInternalRepository,
  logger,
}: {
  esClient: ElasticsearchClient;
  createInternalRepository: (includedHiddenTypes?: string[]) => ISavedObjectsRepository;
  logger: Logger;
}): {
  search: SearchApi;
  getStatus: (options: { inferenceId: string }) => Promise<{ status: string }>;
  getSecurityLabsStatus: (options: { inferenceId: string }) => Promise<{ status: string }>;
} => {
  const productDocClient = new ProductDocInstallClient({
    soClient: new SavedObjectsClient(
      createInternalRepository([productDocInstallStatusSavedObjectType.name])
    ),
    log: logger,
  });
  const searchService = new SearchService({ esClient, logger: logger.get('search-service') });
  return {
    search: searchService.search.bind(searchService),
    getStatus: async ({ inferenceId }) => {
      const installStatus = await productDocClient.getInstallationStatus({ inferenceId });
      return {
        status: getOverallStatus(Object.values(installStatus).map((product) => product.status)),
      };
    },
    getSecurityLabsStatus: async () => {
      throw new Error(
        'The Security Labs status is only available in Kibana, not in a task process'
      );
    },
  };
};
