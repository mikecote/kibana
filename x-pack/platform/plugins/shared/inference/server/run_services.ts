/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import { RegexWorkerService } from '@kbn/ai-anonymization-server';
import type { InferenceConfig } from './config';
import { createClientWithoutRequest } from './inference_client';
import type { ActionsClientProvider, InferenceServerStart } from './types';
import { getConnectorById, getConnectorByIdWithoutClientRequest } from './util/get_connector_by_id';
import { InferenceEndpointIdCache } from './util/inference_endpoint_id_cache';

/** The part of the start contract that works without a request, which a rule run uses. */
export type InferenceRunServices = Pick<
  InferenceServerStart,
  'getConnectorById' | 'getConnectorByIdWithoutClientRequest' | 'getClientWithoutRequest'
>;

export interface CreateInferenceRunServicesOptions {
  /** Where the connectors come from: the actions plugin's start contract, or what runs in its place. */
  actions: ActionsClientProvider;
  /** The internal user client, which resolves aliases and the endpoints behind connectors. */
  esClient: ElasticsearchClient;
  logger: Logger;
  /**
   * The inference config. A process that runs inside a bundle has no worker file for the Piscina pool,
   * so it passes `workers.anonymization.enabled: false` and anonymization runs in the process.
   */
  config: Pick<InferenceConfig, 'workers'>;
  /** The plugin shares its own instances with the rest of its start contract. */
  regexWorker?: RegexWorkerService;
  endpointIdCache?: InferenceEndpointIdCache;
}

/**
 * Builds what the inference plugin's start contract offers to callers that have no request, such as
 * rules: the connector lookups and the client that runs on an actions client the caller brings. The
 * plugin builds its start contract with the same function, and a task process builds it from its host.
 */
export const createInferenceRunServices = ({
  actions,
  esClient,
  logger,
  config,
  regexWorker = new RegexWorkerService(config.workers.anonymization, logger.get('regex_worker')),
  endpointIdCache = new InferenceEndpointIdCache({ esClient }),
}: CreateInferenceRunServicesOptions): InferenceRunServices & {
  regexWorker: RegexWorkerService;
  endpointIdCache: InferenceEndpointIdCache;
} => ({
  regexWorker,
  endpointIdCache,
  getConnectorById: async (id, request) =>
    getConnectorById({
      connectorId: id,
      actions,
      request,
      esClient,
      logger,
    }),
  getClientWithoutRequest: (actionsClient, scopedEsClient) =>
    createClientWithoutRequest({
      actionsClient,
      logger,
      regexWorker,
      esClient: scopedEsClient,
      endpointIdCache,
    }),
  getConnectorByIdWithoutClientRequest: async (id, actionsClient, scopedEsClient) =>
    getConnectorByIdWithoutClientRequest({
      connectorId: id,
      actionsClient,
      esClient: scopedEsClient,
      logger,
    }),
});
