/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Observable } from 'rxjs';
import { of, throwError } from 'rxjs';
import { pick } from 'lodash';
import moment from 'moment';
import type {
  ElasticsearchClient,
  IClusterClient,
  KibanaRequest,
  Logger,
  SavedObjectsServiceStart,
  UiSettingsServiceStart,
} from '@kbn/core/server';
import type { SharedGlobalConfig } from '@kbn/core/server';
import type { FieldFormatsStart } from '@kbn/field-formats-plugin/server';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type {
  IEsSearchRequest,
  IKibanaSearchRequest,
  IKibanaSearchResponse,
  ISearchOptions,
  ISearchGeneric,
} from '@kbn/search-types';
import { KbnServerError } from '@kbn/kibana-utils-plugin/server';
import type { IScopedSearchClient, ISearchStart, SearchStrategyDependencies } from './types';
import {
  ENHANCED_ES_SEARCH_STRATEGY,
  EQL_SEARCH_STRATEGY,
  ES_SEARCH_STRATEGY,
  ESQL_ASYNC_SEARCH_STRATEGY,
  ESQL_SEARCH_STRATEGY,
  SQL_SEARCH_STRATEGY,
  SearchMethodsService,
  SearchSourceService,
  searchSourceRequiredUiSettings,
} from '../../common/search';
import type { SearchConfigSchema } from '../config';
import { searchConfigSchema } from '../config';
import { AggsService } from './aggs';
import { eqlSearchStrategyProvider } from './strategies/eql_search';
import { esSearchStrategyProvider } from './strategies/es_search';
import { esqlAsyncSearchStrategyProvider } from './strategies/esql_async_search';
import { esqlSearchStrategyProvider } from './strategies/esql_search';
import { enhancedEsSearchStrategyProvider } from './strategies/ese_search';
import { sqlSearchStrategyProvider } from './strategies/sql_search';

export interface StandaloneSearchDeps {
  logger: Logger;
  elasticsearch: { client: Pick<IClusterClient, 'asInternalUser' | 'asScoped'> };
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient'>;
  uiSettings: Pick<UiSettingsServiceStart, 'asScopedToClient'>;
  dataViews: Pick<DataViewsServerPluginStart, 'dataViewsServiceFactory'>;
  fieldFormats: FieldFormatsStart;
  /** `data.search` of kibana.yml; its defaults when not given. */
  searchConfig?: SearchConfigSchema;
  /** The shard and request timeouts of the Elasticsearch connection, which searches use. */
  elasticsearchTimeouts?: { shardTimeout?: number; requestTimeout?: number };
  isServerless?: boolean;
}

/**
 * The part of `data.search` that a rule run uses (`asScoped(request).search` and
 * `searchSource.asScoped(request)`), built from the same search strategies, aggregations and search
 * source service as the data plugin, without its HTTP routes, expressions, search sessions and
 * usage collection. A search never joins a search session here.
 */
export const createStandaloneSearch = (
  deps: StandaloneSearchDeps
): Pick<ISearchStart, 'asScoped' | 'searchSource'> => {
  const { logger, elasticsearch, savedObjects, uiSettings, dataViews, fieldFormats } = deps;
  const searchConfig = deps.searchConfig ?? searchConfigSchema.validate({});
  const globalConfig$ = of({
    elasticsearch: {
      shardTimeout: moment.duration(deps.elasticsearchTimeouts?.shardTimeout ?? 30000),
      requestTimeout: moment.duration(deps.elasticsearchTimeouts?.requestTimeout ?? 30000),
    },
  } as unknown as SharedGlobalConfig);

  const strategies = new Map<string | symbol, ReturnType<typeof esqlSearchStrategyProvider>>([
    [ES_SEARCH_STRATEGY, esSearchStrategyProvider(globalConfig$, logger) as never],
    [
      ENHANCED_ES_SEARCH_STRATEGY,
      enhancedEsSearchStrategyProvider(
        globalConfig$,
        searchConfig,
        logger,
        undefined,
        false,
        deps.isServerless
      ) as never,
    ],
    [ESQL_SEARCH_STRATEGY, esqlSearchStrategyProvider(logger)],
    [ESQL_ASYNC_SEARCH_STRATEGY, esqlAsyncSearchStrategyProvider(searchConfig, logger) as never],
    [EQL_SEARCH_STRATEGY, eqlSearchStrategyProvider(searchConfig, logger) as never],
    [SQL_SEARCH_STRATEGY, sqlSearchStrategyProvider(searchConfig, logger) as never],
  ]);

  const aggsService = new AggsService();
  aggsService.setup({ registerFunction: () => undefined });
  const aggs = aggsService.start({
    fieldFormats,
    uiSettings: uiSettings as UiSettingsServiceStart,
    indexPatterns: dataViews as DataViewsServerPluginStart,
  });
  const searchSourceService = new SearchSourceService();
  searchSourceService.setup();

  const scopedEsClient = (request: KibanaRequest, opts?: unknown) =>
    opts
      ? (
          elasticsearch.client.asScoped as (
            r: KibanaRequest,
            o: unknown
          ) => ReturnType<IClusterClient['asScoped']>
        )(request, opts)
      : elasticsearch.client.asScoped(request);

  const asScoped = (request: KibanaRequest, opts?: unknown): IScopedSearchClient => {
    const savedObjectsClient = savedObjects.getScopedClient(request);
    const strategyDeps = {
      savedObjectsClient,
      esClient: scopedEsClient(request, opts),
      uiSettingsClient: uiSettings.asScopedToClient(savedObjectsClient),
      request,
      rollupsEnabled: false,
      // Rule runs do not use search sessions.
      searchSessionsClient: undefined,
    } as unknown as SearchStrategyDependencies;

    const search = <
      SearchStrategyRequest extends IKibanaSearchRequest = IEsSearchRequest,
      SearchStrategyResponse extends IKibanaSearchResponse = IKibanaSearchResponse
    >(
      searchRequest: SearchStrategyRequest,
      options: ISearchOptions = {}
    ) => {
      const strategy = strategies.get(options.strategy ?? ENHANCED_ES_SEARCH_STRATEGY);
      if (!strategy) {
        return throwError(
          () => new KbnServerError(`Search strategy ${String(options.strategy)} not found`, 404)
        );
      }
      return (
        strategy.search as unknown as (...args: unknown[]) => Observable<SearchStrategyResponse>
      )(searchRequest, options, strategyDeps);
    };
    const methods = new SearchMethodsService(search as ISearchGeneric);
    return {
      search,
      dsl: methods.dsl.bind(methods),
      dslPaginated: methods.dslPaginated.bind(methods),
      esql: methods.esql.bind(methods),
      eql: methods.eql.bind(methods),
      sql: methods.sql.bind(methods),
    } as unknown as IScopedSearchClient;
  };

  return {
    asScoped,
    searchSource: {
      asScoped: async (request: KibanaRequest, opts?: unknown) => {
        const esClient = scopedEsClient(request, opts);
        const savedObjectsClient = savedObjects.getScopedClient(request);
        const scopedDataViews = await dataViews.dataViewsServiceFactory(
          savedObjectsClient,
          esClient.asCurrentUser as ElasticsearchClient
        );
        const uiSettingsCache = pick(
          await uiSettings.asScopedToClient(savedObjectsClient).getAll(),
          searchSourceRequiredUiSettings
        );
        return searchSourceService.start(scopedDataViews, {
          aggs: await aggs.asScopedToClient(savedObjectsClient, esClient.asCurrentUser),
          getConfig: <T = unknown>(key: string): T => uiSettingsCache[key] as T,
          search: asScoped(request, opts).search,
          onResponse: (_request, response) => response,
          dataViews: scopedDataViews,
          scriptedFieldsEnabled: true,
        });
      },
    },
  } as unknown as Pick<ISearchStart, 'asScoped' | 'searchSource'>;
};
