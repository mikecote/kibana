/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ElasticsearchClient,
  RouteConfig,
  SavedObjectsClientContract,
} from '@kbn/core/server';
import type {
  CoreSetup,
  IRouter,
  KibanaRequest,
  RequestHandler,
  RouteMethod,
} from '@kbn/core/server';
import type { TimeseriesVisData } from '@kbn/vis-type-timeseries-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { TSVBMetricModel } from '@kbn/metrics-data-access-plugin/common';
import type { InfraConfig, InfraPluginRequestHandlerContext } from '../../../types';
import type {
  InfraRouteConfig,
  InfraServerPluginSetupDeps,
  InfraServerPluginStartDeps,
  InfraVersionedRouteConfig,
} from './adapter_types';
import { callWithRequest } from './call_with_request';

export class KibanaFramework {
  public router: IRouter<InfraPluginRequestHandlerContext>;
  public plugins: InfraServerPluginSetupDeps;
  public config: InfraConfig;
  private core: CoreSetup<InfraServerPluginStartDeps>;

  constructor(
    core: CoreSetup<InfraServerPluginStartDeps>,
    config: InfraConfig,
    plugins: InfraServerPluginSetupDeps
  ) {
    this.router = core.http.createRouter();
    this.plugins = plugins;
    this.core = core;
    this.config = config;
  }

  public registerRoute<Params = any, Query = any, Body = any, Method extends RouteMethod = any>(
    config: InfraRouteConfig<Params, Query, Body, Method>,
    handler: RequestHandler<Params, Query, Body, InfraPluginRequestHandlerContext>
  ) {
    const defaultSecurity = { authz: { requiredPrivileges: ['infra'] } };

    const routeConfig = {
      path: config.path,
      validate: config.validate,
      /**
       * Supported `options` for each type of request method
       * are a bit different and generic method like this cannot
       * properly ensure type safety. Hence the need to cast
       * using `as ...` below to ensure the route config has
       * the correct options type.
       */
      options: { ...config.options },
      security: defaultSecurity,
    };
    switch (config.method) {
      case 'get':
        this.router.get(routeConfig as RouteConfig<Params, Query, Body, 'get'>, handler);
        break;
      case 'post':
        this.router.post(routeConfig as RouteConfig<Params, Query, Body, 'post'>, handler);
        break;
      case 'delete':
        this.router.delete(routeConfig as RouteConfig<Params, Query, Body, 'delete'>, handler);
        break;
      case 'put':
        this.router.put(routeConfig as RouteConfig<Params, Query, Body, 'put'>, handler);
        break;
      case 'patch':
        this.router.patch(routeConfig as RouteConfig<Params, Query, Body, 'patch'>, handler);
        break;
    }
  }

  public registerVersionedRoute<Method extends RouteMethod = any>(
    config: InfraVersionedRouteConfig<Method>
  ) {
    const defaultSecurity = { authz: { requiredPrivileges: ['infra'] } };

    const routeConfig = {
      access: config.access,
      path: config.path,
      security: defaultSecurity,
    };
    switch (config.method) {
      case 'get':
        return this.router.versioned.get(routeConfig);
      case 'post':
        return this.router.versioned.post(routeConfig);
      case 'delete':
        return this.router.versioned.delete(routeConfig);
      case 'put':
        return this.router.versioned.put(routeConfig);
      case 'patch':
        return this.router.versioned.patch(routeConfig);
      default:
        throw new RangeError(
          `#registerVersionedRoute: "${config.method}" is not an accepted method`
        );
    }
  }

  public callWithRequest = callWithRequest;

  public async getIndexPatternsServiceWithRequestContext(
    requestContext: InfraPluginRequestHandlerContext
  ) {
    const { savedObjects, elasticsearch } = await requestContext.core;
    return await this.createIndexPatternsService(
      savedObjects.client,
      elasticsearch.client.asCurrentUser
    );
  }

  public async getIndexPatternsService(
    savedObjectsClient: SavedObjectsClientContract,
    elasticsearchClient: ElasticsearchClient
  ) {
    return await this.createIndexPatternsService(savedObjectsClient, elasticsearchClient);
  }

  private async createIndexPatternsService(
    savedObjectsClient: SavedObjectsClientContract,
    elasticsearchClient: ElasticsearchClient
  ) {
    const [, startPlugins] = await this.core.getStartServices();
    return startPlugins.data.indexPatterns.dataViewsServiceFactory(
      savedObjectsClient,
      elasticsearchClient
    );
  }

  public getSpaceId(request: KibanaRequest): string {
    return this.plugins.spaces?.spacesService?.getSpaceId(request) ?? DEFAULT_SPACE_ID;
  }

  public async makeTSVBRequest(
    requestContext: InfraPluginRequestHandlerContext,
    rawRequest: KibanaRequest,
    model: TSVBMetricModel,
    timerange: { min: number; max: number },
    filters: any[]
  ): Promise<TimeseriesVisData> {
    const { getVisData } = this.plugins.visTypeTimeseries;
    if (typeof getVisData !== 'function') {
      throw new Error('TSVB is not available');
    }
    const options = {
      timerange,
      panels: [model],
      filters,
    };
    return getVisData(requestContext, rawRequest, options);
  }
}
