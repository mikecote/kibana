/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { JsonObject } from '@kbn/utility-types';
import type { estypes } from '@elastic/elasticsearch';
import type {
  AggregationsAggregationContainer,
  Indices,
  MappingRuntimeFields,
  Sort,
} from '@elastic/elasticsearch/lib/api/types';

import type { SecuritySolutionRequestHandlerContext } from '../../../../../types';
import type { QueryAlertsBodyParams } from '../../../../../../common/api/detection_engine/signals';

interface SearchAlertsArgs {
  context: SecuritySolutionRequestHandlerContext;
  index: undefined | Indices;
  params: QueryAlertsBodyParams;
}

/** Runs a search with the caller's native scoped client and the validated signals parameters. */
export const searchAlertsWithClient = <
  TDocument = JsonObject,
  TAggregations = Record<string, estypes.AggregationsAggregate>
>({
  esClient,
  index,
  params,
}: Omit<SearchAlertsArgs, 'context'> & {
  esClient: ElasticsearchClient;
}): Promise<estypes.SearchResponse<TDocument, TAggregations>> => {
  const {
    query,
    aggs,
    _source,
    fields,
    track_total_hits: trackTotalHits,
    size,
    runtime_mappings: runtimeMappings,
    sort,
  } = params;

  return esClient.search<TDocument, TAggregations>({
    index,
    query,
    aggs: aggs as Record<string, AggregationsAggregationContainer>,
    _source,
    fields,
    track_total_hits: trackTotalHits,
    size,
    runtime_mappings: runtimeMappings as MappingRuntimeFields,
    sort: sort as Sort,
    ignore_unavailable: true,
  });
};

/** Searches alerts through the request context's genuine scoped Elasticsearch client. */
export const searchAlerts = async ({ context, index, params }: SearchAlertsArgs) =>
  searchAlertsWithClient({
    esClient: (await context.core).elasticsearch.client.asCurrentUser,
    index,
    params,
  });
