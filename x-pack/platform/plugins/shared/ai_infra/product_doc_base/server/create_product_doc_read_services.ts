/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, ISavedObjectsRepository, Logger } from '@kbn/core/server';
import { SavedObjectsClient } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import { ProductDocInstallClient } from './services/doc_install_status';
import type { ProductDocBaseConfig } from './config';
import { getProductDocStatus } from './services/doc_manager/get_product_doc_status';
import { PackageInstaller } from './services/package_installer';
import type {
  DocGetStatusResponse,
  SecurityLabsStatusResponse,
} from './services/doc_manager/types';
import { SearchService } from './services/search';
import type { SearchApi } from './services/search';
import { productDocInstallStatusSavedObjectType } from './saved_objects';

export const PRODUCT_DOC_READ_SETTINGS_ID = 'productDocRead';
export type ProductDocReadSettings = Pick<
  ProductDocBaseConfig,
  'artifactRepositoryUrl' | 'artifactRepositoryProxyUrl' | 'elserInferenceId'
>;

/** The saved object type the install status is read from: a process declares it. */
export const productDocReadSavedObjectTypes = [productDocInstallStatusSavedObjectType];

/** Builds native documentation readers with the same status and package clients as Main. */
export const createProductDocReadServices = ({
  esClient,
  createInternalRepository,
  logger,
  taskManager,
  settings,
  kibanaVersion,
  isServerless,
}: {
  esClient: ElasticsearchClient;
  createInternalRepository: (includedHiddenTypes?: string[]) => ISavedObjectsRepository;
  logger: Logger;
  taskManager: Pick<TaskManagerStartContract, 'fetch'>;
  settings: ProductDocReadSettings;
  kibanaVersion: string;
  isServerless: boolean;
}): {
  search: SearchApi;
  getStatus: (options: { inferenceId: string }) => Promise<DocGetStatusResponse>;
  getSecurityLabsStatus: (options: { inferenceId: string }) => Promise<SecurityLabsStatusResponse>;
} => {
  const productDocClient = new ProductDocInstallClient({
    soClient: new SavedObjectsClient(
      createInternalRepository([productDocInstallStatusSavedObjectType.name])
    ),
    log: logger,
  });
  const searchService = new SearchService({ esClient, logger: logger.get('search-service') });
  const installer = new PackageInstaller({
    esClient,
    productDocClient,
    logger: logger.get('package-installer'),
    artifactsFolder: 'ai-kb-artifacts',
    kibanaVersion,
    isServerless,
    ...settings,
  });
  return {
    search: searchService.search.bind(searchService),
    getStatus: ({ inferenceId }) =>
      getProductDocStatus({ taskManager, docInstallClient: productDocClient, inferenceId }),
    getSecurityLabsStatus: (options) => installer.getSecurityLabsStatus(options),
  };
};
