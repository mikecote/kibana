/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ElasticsearchClient,
  KibanaRequest,
  Logger,
  SavedObjectsClientContract,
} from '@kbn/core/server';
import type { PluginStart as DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { LogSourcesService } from '@kbn/logs-data-access-plugin/common/types';
import type { LogView, LogViewAttributes, LogViewsStaticConfig } from '../../../common/log_views';
import {
  defaultLogViewAttributes,
  defaultLogViewId,
  defaultLogViewsStaticConfig,
} from '../../../common/log_views';
import { LogViewsClient } from './log_views_client';
import type {
  LogViewFallbackHandler,
  LogViewsServiceSetup,
  LogViewsServiceStart,
  LogViewsServiceStartDeps,
} from './types';

type DataViewsServiceFactory = DataViewsServerPluginStart['dataViewsServiceFactory'];

export interface LogViewsClientFactoryDeps {
  logger: Logger;
  dataViewsServiceFactory: DataViewsServiceFactory;
  internalLogViews: Map<string, LogView>;
  logViewFallbackHandler: LogViewFallbackHandler;
  logViewsStaticConfig: LogViewsStaticConfig;
}

export const createInternalLogView = (
  logViewId: string,
  logViewAttributes: Partial<LogViewAttributes>
): LogView => ({
  id: logViewId,
  origin: 'internal',
  attributes: { ...defaultLogViewAttributes, ...logViewAttributes },
  updatedAt: Date.now(),
});

/**
 * The internal log views that exist without anyone defining them: a static one to fall back on where
 * the log view saved object is not registered (serverless).
 */
export const getBuiltInInternalLogViews = (isServerless: boolean): Map<string, LogView> =>
  new Map(isServerless ? [[defaultLogViewId, createInternalLogView(defaultLogViewId, {})]] : []);

/**
 * Builds log views clients from explicit services, so a task process builds them the way the plugin
 * does.
 */
export const createLogViewsClientFactory =
  ({
    logger,
    dataViewsServiceFactory,
    internalLogViews,
    logViewFallbackHandler,
    logViewsStaticConfig,
  }: LogViewsClientFactoryDeps) =>
  (
    savedObjectsClient: SavedObjectsClientContract,
    elasticsearchClient: ElasticsearchClient,
    logSourcesService: Promise<LogSourcesService>,
    request?: KibanaRequest
  ) =>
    new LogViewsClient(
      logger,
      dataViewsServiceFactory(savedObjectsClient, elasticsearchClient, request),
      logSourcesService,
      savedObjectsClient,
      logViewFallbackHandler,
      internalLogViews,
      logViewsStaticConfig
    );

export class LogViewsService {
  private internalLogViews: Map<string, LogView> = new Map();
  private logViewFallbackHandler: LogViewFallbackHandler | null = null;
  private logViewsStaticConfig: LogViewsStaticConfig = defaultLogViewsStaticConfig;

  constructor(private readonly logger: Logger) {}

  public setup(): LogViewsServiceSetup {
    const { internalLogViews } = this;

    return {
      defineInternalLogView: (logViewId: string, logViewAttributes: Partial<LogViewAttributes>) => {
        internalLogViews.set(logViewId, createInternalLogView(logViewId, logViewAttributes));
      },
      registerLogViewFallbackHandler: (handler) => {
        this.logViewFallbackHandler = handler;
      },
      setLogViewsStaticConfig: (config: LogViewsStaticConfig) => {
        this.logViewsStaticConfig = config;
      },
    };
  }

  public start({
    dataViews,
    logsDataAccess,
    elasticsearch,
    savedObjects,
  }: LogViewsServiceStartDeps): LogViewsServiceStart {
    const { internalLogViews, logger, logViewFallbackHandler, logViewsStaticConfig } = this;

    const getClient = createLogViewsClientFactory({
      logger,
      dataViewsServiceFactory: dataViews.dataViewsServiceFactory,
      internalLogViews,
      logViewFallbackHandler,
      logViewsStaticConfig,
    });

    return {
      getClient,
      getScopedClient(request: KibanaRequest) {
        const savedObjectsClient = savedObjects.getScopedClient(request);
        const elasticsearchClient = elasticsearch.client.asScoped(request).asCurrentUser;
        const logSourcesService =
          logsDataAccess.services.logSourcesServiceFactory.getScopedLogSourcesService(request);
        return this.getClient(savedObjectsClient, elasticsearchClient, logSourcesService, request);
      },
    };
  }
}
