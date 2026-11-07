/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes, TransportRequestParams } from '@elastic/elasticsearch';
import type { IScopedClusterClient, IUiSettingsClient, KibanaRequest } from '@kbn/core/server';
import { UI_SETTINGS } from '@kbn/data-plugin/server';
import { getProjectRoutingFromRequest } from '@kbn/observability-utils-server/es/get_project_routing_from_request';
import { subscribeToAborted$ } from '../../cancel_request_on_abort';
import type {
  CallWithRequestParams,
  InfraDatabaseGetIndicesAliasResponse,
  InfraDatabaseGetIndicesResponse,
  InfraDatabaseMultiResponse,
  InfraDatabaseSearchResponse,
} from './adapter_types';

export interface InfraSearchRequestContext {
  core: Promise<{
    elasticsearch: { client: Pick<IScopedClusterClient, 'asCurrentUser'> };
    uiSettings: { client: Pick<IUiSettingsClient, 'get'> };
  }>;
}

interface FrozenIndexParams {
  ignore_throttled?: boolean;
}

export function callWithRequest<Hit = {}, Aggregation = undefined>(
  requestContext: InfraSearchRequestContext,
  endpoint: 'search',
  options?: CallWithRequestParams | estypes.SearchRequest,
  request?: KibanaRequest
): Promise<InfraDatabaseSearchResponse<Hit, Aggregation>>;
export function callWithRequest<Hit = {}, Aggregation = undefined>(
  requestContext: InfraSearchRequestContext,
  endpoint: 'msearch',
  options?: CallWithRequestParams | estypes.MsearchRequest,
  request?: KibanaRequest
): Promise<InfraDatabaseMultiResponse<Hit, Aggregation>>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  endpoint: 'indices.existsAlias',
  options?: CallWithRequestParams,
  request?: KibanaRequest
): Promise<boolean>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  method: 'indices.getAlias',
  options?: object,
  request?: KibanaRequest
): Promise<InfraDatabaseGetIndicesAliasResponse>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  method: 'indices.resolveCluster',
  options?: CallWithRequestParams,
  request?: KibanaRequest
): Promise<estypes.IndicesResolveClusterResponse>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  method: 'indices.get' | 'ml.getBuckets',
  options?: object,
  request?: KibanaRequest
): Promise<InfraDatabaseGetIndicesResponse>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  method: 'transport.request',
  options?: CallWithRequestParams,
  request?: KibanaRequest
): Promise<unknown>;
export function callWithRequest(
  requestContext: InfraSearchRequestContext,
  endpoint: string,
  options?: CallWithRequestParams,
  request?: KibanaRequest
): Promise<InfraDatabaseSearchResponse>;
export async function callWithRequest(
  requestContext: InfraSearchRequestContext,
  endpoint: string,
  rawParams: object = {},
  request?: KibanaRequest
) {
  // `requestTimeout` is a transport-level option, not part of the request
  // body, so it must be pulled off before `params` gets spread into the
  // Elasticsearch client call bodies below.
  const { requestTimeout, ...paramsWithoutTimeout }: CallWithRequestParams = rawParams;
  let params: CallWithRequestParams = paramsWithoutTimeout;
  const { elasticsearch, uiSettings } = await requestContext.core;

  const includeFrozen = await uiSettings.client.get<boolean>(UI_SETTINGS.SEARCH_INCLUDE_FROZEN);
  if (endpoint === 'msearch') {
    const maxConcurrentShardRequests = await uiSettings.client.get(
      UI_SETTINGS.COURIER_MAX_CONCURRENT_SHARD_REQUESTS
    );
    if (maxConcurrentShardRequests > 0) {
      params = { ...params, max_concurrent_shard_requests: maxConcurrentShardRequests };
    }
  }

  function callWrapper<T>({
    makeRequestWithSignal,
  }: {
    makeRequestWithSignal: (signal: AbortSignal) => Promise<T>;
  }) {
    const controller = new AbortController();
    const promise = makeRequestWithSignal(controller.signal);
    return request ? subscribeToAborted$(promise, request, controller) : promise;
  }

  // Only set the "ignore_throttled" value (to false) if the Kibana setting
  // for "search:includeFrozen" is true (i.e. don't ignore throttled indices, a triple negative!)
  // More information:
  // - https://github.com/elastic/kibana/issues/113197
  // - https://github.com/elastic/elasticsearch/pull/77479
  //
  // NOTE: these params only need to be spread onto the search and msearch calls below
  const frozenIndicesParams: FrozenIndexParams = {};
  if (includeFrozen) {
    frozenIndicesParams.ignore_throttled = false;
  }

  const projectRouting = getProjectRoutingFromRequest(request);
  const projectRoutingParams = projectRouting ? { project_routing: projectRouting } : {};

  let apiResult;
  switch (endpoint) {
    case 'search':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.search(
            {
              ...params,
              ...frozenIndicesParams,
              ...projectRoutingParams,
            } as estypes.SearchRequest,
            { signal, ...(requestTimeout ? { requestTimeout } : {}) }
          ),
      });

      break;
    case 'msearch':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.msearch(
            {
              ...params,
              ...frozenIndicesParams,
              ...projectRoutingParams,
            } as estypes.MsearchRequest,
            { signal }
          ),
      });

      break;
    case 'indices.resolveCluster':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.indices.resolveCluster(
            {
              ...params,
            } as estypes.IndicesResolveClusterRequest,
            { signal, ...(requestTimeout ? { requestTimeout } : {}) }
          ),
      });

      break;
    case 'indices.existsAlias':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.indices.existsAlias(
            {
              ...params,
            } as estypes.IndicesExistsAliasRequest,
            { signal }
          ),
      });

      break;
    case 'indices.getAlias':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.indices.getAlias(
            {
              ...params,
            } as estypes.IndicesGetAliasRequest,
            { signal }
          ),
      });

      break;
    case 'indices.get':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.indices.get(
            {
              ...params,
            } as estypes.IndicesGetRequest,
            { signal }
          ),
      });

      break;
    case 'transport.request':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.transport.request(
            {
              ...params,
            } as TransportRequestParams,
            { signal }
          ),
      });

      break;
    case 'ml.getBuckets':
      apiResult = callWrapper({
        makeRequestWithSignal: (signal) =>
          elasticsearch.client.asCurrentUser.ml.getBuckets(
            {
              ...params,
            } as estypes.MlGetBucketsRequest,
            { signal }
          ),
      });

      break;
  }
  return apiResult ? await apiResult : undefined;
}
