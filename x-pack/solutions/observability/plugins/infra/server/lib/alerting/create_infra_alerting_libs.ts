/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ElasticsearchClient,
  IBasePath,
  Logger,
  SavedObjectsClientContract,
  SavedObjectsServiceStart,
  UiSettingsServiceStart,
} from '@kbn/core/server';
import type { PluginStart as DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type {
  MetricsDataClient,
  GetMetricIndicesOptions,
} from '@kbn/metrics-data-access-plugin/server';
import {
  createLogViewsClientFactory,
  getBuiltInInternalLogViews,
} from '@kbn/logs-shared-plugin/server/services/log_views';
import type {
  ILogViewsClient,
  LogViewFallbackHandler,
} from '@kbn/logs-shared-plugin/server/services/log_views/types';
import type { LogViewsStaticConfig } from '@kbn/logs-shared-plugin/common/log_views';
import { createLogSourcesServiceFactory } from '@kbn/logs-data-access-plugin/server/services/log_sources_service';
import type { InfraConfig } from '../../types';
import { InfraSources } from '../sources';
import { mapSourceToLogView } from '../../utils/map_source_to_log_view';
import type { InfraBackendLibs } from '../infra_types';

/** What the infra rule executors read of the plugin's libs. */
export type InfraAlertingLibs = Pick<
  InfraBackendLibs,
  'logger' | 'basePath' | 'configuration' | 'sources' | 'getLogViewsClient'
>;

/**
 * The sources of infra, which read the metric indices of the metrics data client and fall back to its
 * default handler, which reads the infra source configuration. The plugin and a task process build
 * them the same way.
 */
export const createInfraSources = ({ metricsClient }: { metricsClient: MetricsDataClient }) => {
  const sources = new InfraSources({ metricsClient });
  metricsClient.setDefaultMetricIndicesHandler(
    async (options: GetMetricIndicesOptions) => {
      const sourceConfiguration = await sources.getInfraSourceConfiguration(
        options.savedObjectsClient,
        'default'
      );
      return sourceConfiguration.configuration.metricAlias;
    },
    { owner: 'infra' }
  );
  return sources;
};

/** What infra tells the log views service: where a log view that is not stored comes from. */
export const getInfraLogViewsSettings = ({
  sources,
  configuration,
}: {
  sources: InfraSources;
  configuration: InfraConfig;
}): {
  logViewFallbackHandler: NonNullable<LogViewFallbackHandler>;
  logViewsStaticConfig: LogViewsStaticConfig;
} => ({
  logViewFallbackHandler: async (sourceId, { soClient }) =>
    mapSourceToLogView(await sources.getInfraSourceConfiguration(soClient, sourceId)),
  logViewsStaticConfig: { messageFields: configuration.sources?.default?.fields?.message },
});

export interface InfraAlertingLibsDeps {
  logger: Logger;
  /** Rules only read the public base URL, which is all a task process has of the base path. */
  basePath: Pick<IBasePath, 'publicBaseUrl'>;
  configuration: InfraConfig;
  sources: InfraSources;
  getLogViewsClient: InfraAlertingLibs['getLogViewsClient'];
}

/** The libs the infra rule executors read, from explicit services: Kibana's or a task process's. */
export const createInfraAlertingLibs = ({
  logger,
  basePath,
  configuration,
  sources,
  getLogViewsClient,
}: InfraAlertingLibsDeps): InfraAlertingLibs => ({
  logger,
  basePath: basePath as IBasePath,
  configuration,
  sources,
  getLogViewsClient,
});

export interface InfraLogViewsServices {
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient'>;
  dataViews: Pick<DataViewsServerPluginStart, 'dataViewsServiceFactory'>;
  uiSettings: Pick<UiSettingsServiceStart, 'asScopedToClient'>;
}

/**
 * A log views client getter that builds its clients from explicit services, which are read when a
 * client is requested, not when the getter is built, so a rule type can be built before they exist.
 */
export const createLogViewsClientGetter = ({
  logger,
  sources,
  configuration,
  isServerless,
  getServices,
}: {
  logger: Logger;
  sources: InfraSources;
  configuration: InfraConfig;
  isServerless: boolean;
  getServices: () => InfraLogViewsServices;
}): InfraAlertingLibs['getLogViewsClient'] => {
  const internalLogViews = getBuiltInInternalLogViews(isServerless);
  const settings = getInfraLogViewsSettings({ sources, configuration });
  const logSourcesServiceFactory = createLogSourcesServiceFactory({
    logger,
    // Reading the log sources needs the ui settings only.
    deps: {
      get uiSettings() {
        return getServices().uiSettings as UiSettingsServiceStart;
      },
      // Core's saved objects, read when a request needs them (`getScopedLogSourcesService`).
      get savedObjects() {
        return getServices().savedObjects as SavedObjectsServiceStart;
      },
    },
  });

  return async ({
    savedObjectsClient,
    esClient,
  }: {
    savedObjectsClient: SavedObjectsClientContract;
    esClient: ElasticsearchClient;
  }): Promise<ILogViewsClient> =>
    createLogViewsClientFactory({
      logger,
      dataViewsServiceFactory: getServices().dataViews.dataViewsServiceFactory,
      internalLogViews,
      ...settings,
    })(
      savedObjectsClient,
      esClient,
      logSourcesServiceFactory.getLogSourcesService(savedObjectsClient)
    );
};
