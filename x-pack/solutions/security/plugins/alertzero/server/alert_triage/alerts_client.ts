/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { KibanaRequest } from '@kbn/core/server';
import type { JsonObject } from '@kbn/utility-types';

export type TriageAlertsSearchParams = Pick<
  estypes.SearchRequest,
  | 'query'
  | 'aggs'
  | 'size'
  | 'sort'
  | '_source'
  | 'fields'
  | 'runtime_mappings'
  | 'track_total_hits'
>;

export interface TriageAlertTagUpdate {
  ids: string[];
  tags: { tags_to_add: string[]; tags_to_remove: string[] };
}

/** The request-scoped search and tag operations triage needs from the alerts owner. */
export interface AlertTriageAlertsClient {
  search: <TDocument = JsonObject, TAggregations = Record<string, estypes.AggregationsAggregate>>(
    params: TriageAlertsSearchParams
  ) => Promise<estypes.SearchResponse<TDocument, TAggregations>>;
  updateTags: (params: TriageAlertTagUpdate) => Promise<estypes.UpdateByQueryResponse>;
}

export type AlertTriageAlertsClientFactory = (
  request: KibanaRequest
) => Promise<AlertTriageAlertsClient>;
