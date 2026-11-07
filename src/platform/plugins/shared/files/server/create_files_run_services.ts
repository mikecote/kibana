/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ElasticsearchClient, Logger, SavedObjectsServiceStart } from '@kbn/core/server';
import type { SecurityPluginSetup } from '@kbn/security-plugin/server';
import { FileKindsRegistryImpl } from '../common/file_kinds_registry';
import type { FileKindsRegistry } from '../common/file_kinds_registry';
import type { FileKind } from '../common/types';
import { BlobStorageService } from './blob_storage_service';
import { FileServiceFactoryImpl } from './file_service/file_service_factory';
import { fileObjectType, fileShareObjectType } from './saved_objects';
import type { FileAnalytics } from './performance/analytics';

/** The saved object types the file service reads and writes: a task process declares them. */
export const filesRunSavedObjectTypes = [fileObjectType, fileShareObjectType];

/**
 * The file service factory (and the registry of file kinds it reads), built from explicit
 * dependencies: the plugin's `start()` calls it with Kibana's services and a task process with the
 * host's. Blobs are stored in Elasticsearch as the plugin does.
 */
export const createFileServiceFactory = ({
  savedObjects,
  esClient,
  security,
  fileKindsRegistry,
  logger,
  analytics,
}: {
  savedObjects: SavedObjectsServiceStart;
  esClient: ElasticsearchClient;
  security?: SecurityPluginSetup;
  fileKindsRegistry: FileKindsRegistry;
  logger: Logger;
  analytics?: FileAnalytics;
}): FileServiceFactoryImpl =>
  new FileServiceFactoryImpl(
    savedObjects,
    new BlobStorageService(esClient, logger.get('blob-storage-service'), analytics),
    security,
    fileKindsRegistry,
    logger.get('files-service'),
    analytics
  );

/**
 * A task process's file services: a registry of the given file kinds (the ones plugins register with
 * `registerFileKind` in Kibana) and the factory over it.
 */
export const createFilesRunServices = ({
  fileKinds,
  ...deps
}: {
  savedObjects: SavedObjectsServiceStart;
  esClient: ElasticsearchClient;
  security?: SecurityPluginSetup;
  logger: Logger;
  analytics?: FileAnalytics;
  fileKinds: FileKind[];
}): { fileServiceFactory: FileServiceFactoryImpl } => {
  const fileKindsRegistry = new FileKindsRegistryImpl();
  fileKinds.forEach((fileKind) => fileKindsRegistry.register(fileKind));
  return { fileServiceFactory: createFileServiceFactory({ ...deps, fileKindsRegistry }) };
};
