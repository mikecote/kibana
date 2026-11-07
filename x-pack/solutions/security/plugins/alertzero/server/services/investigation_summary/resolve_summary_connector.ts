/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ALERTZERO_FRONTIER_INFERENCE_FEATURE_ID } from '@kbn/alertzero-common';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';

/** Resolves the summary connector through the same feature policy as the AlertZero plugin. */
export const createResolveSummaryConnectorId =
  (
    getSearchInferenceEndpoints: () =>
      | Pick<SearchInferenceEndpointsPluginStart, 'endpoints'>
      | undefined,
    logger: Pick<Logger, 'warn'>
  ): ((request: KibanaRequest) => Promise<string | undefined>) =>
  async (request) => {
    const endpoints = getSearchInferenceEndpoints();
    if (!endpoints) return undefined;
    try {
      const result = await endpoints.endpoints.getForFeature(
        ALERTZERO_FRONTIER_INFERENCE_FEATURE_ID,
        request
      );
      return result.endpoints[0]?.connectorId;
    } catch (error) {
      logger.warn(
        `AlertZero investigation summary connector could not be resolved. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  };
