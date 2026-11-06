/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  PluginInitializerContext,
  CoreSetup,
  Plugin,
  Logger,
  CoreStart,
} from '@kbn/core/server';

import { setFileAnalytics } from './performance/analytics';
import { PLUGIN_ID } from '../common/constants';
import {
  setFileKindsRegistry,
  getFileKindsRegistry,
  FileKindsRegistryImpl,
} from '../common/file_kinds_registry';

import { FileServiceFactory } from './file_service';
import { createFileServiceFactory } from './create_files_run_services';
import type {
  FilesServerSetupDependencies,
  FilesServerStartDependencies,
  FilesServerSetup,
  FilesServerStart,
} from './types';

import type { FilesRequestHandlerContext, FilesRouter } from './routes/types';
import { registerRoutes, registerFileKindRoutes } from './routes';
import type { Counters } from './usage';
import { registerUsageCollector } from './usage';
import * as DefaultImageKind from '../common/default_image_file_kind';

export class FilesPlugin
  implements
    Plugin<
      FilesServerSetup,
      FilesServerStart,
      FilesServerSetupDependencies,
      FilesServerStartDependencies
    >
{
  private readonly logger: Logger;
  private fileServiceFactory: undefined | FileServiceFactory;
  private securitySetup: FilesServerSetupDependencies['security'];
  private securityStart: FilesServerStartDependencies['security'];

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  public setup(
    core: CoreSetup,
    { security, usageCollection }: FilesServerSetupDependencies
  ): FilesServerSetup {
    const usageCounter = usageCollection?.createUsageCounter(PLUGIN_ID);
    FileServiceFactory.setup(core.savedObjects, usageCounter);
    this.securitySetup = security;

    core.http.registerRouteHandlerContext<FilesRequestHandlerContext, typeof PLUGIN_ID>(
      PLUGIN_ID,
      async (ctx, req) => {
        return {
          security: this.securityStart,
          fileService: {
            asCurrentUser: () => this.fileServiceFactory!.asScoped(req),
            asInternalUser: () => this.fileServiceFactory!.asInternal(),
            logger: this.logger.get('files-routes'),
            usageCounter: usageCounter
              ? (counter: Counters) => usageCounter.incrementCounter({ counterName: counter })
              : undefined,
          },
        };
      }
    );

    const router: FilesRouter = core.http.createRouter();
    registerRoutes(router);
    setFileKindsRegistry(
      new FileKindsRegistryImpl((fk) => {
        registerFileKindRoutes(router, fk);
      })
    );
    registerUsageCollector({
      usageCollection,
      getFileService: () => this.fileServiceFactory?.asInternal(),
    });

    this.registerDefaultImageFileKind();

    return {
      registerFileKind(fileKind) {
        getFileKindsRegistry().register(fileKind);
      },
    };
  }

  public start(coreStart: CoreStart, { security }: FilesServerStartDependencies): FilesServerStart {
    const { savedObjects, analytics } = coreStart;
    this.securityStart = security;
    setFileAnalytics(analytics);
    const esClient = coreStart.elasticsearch.client.asInternalUser;
    this.fileServiceFactory = createFileServiceFactory({
      savedObjects,
      esClient,
      security: this.securitySetup,
      fileKindsRegistry: getFileKindsRegistry(),
      logger: this.logger,
      analytics,
    });

    return {
      fileServiceFactory: this.fileServiceFactory,
    };
  }

  public stop() {
    setFileAnalytics(undefined);
  }

  private registerDefaultImageFileKind() {
    const registry = getFileKindsRegistry();
    registry.register({
      ...DefaultImageKind.kind,
      maxSizeBytes: DefaultImageKind.maxSize,
      http: {
        create: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        delete: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        download: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        getById: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        list: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        share: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
        update: { requiredPrivileges: DefaultImageKind.requiredPrivileges },
      },
      hashes: ['sha256'],
    });
  }
}
