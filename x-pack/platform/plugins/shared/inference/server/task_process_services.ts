/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import { configSchema } from './config';
import type { InferenceServicesCore } from './create_inference_services';
import { createInferenceServices } from './create_inference_services';
import { TokenUsageLogger } from './token_usage';
import type { InferenceServerStart } from './types';
import { InferenceEndpointIdCache } from './util/inference_endpoint_id_cache';

/**
 * The inference plugin's start contract in a task process, built by the function the plugin builds
 * it with, from the host of the process and the actions client of the run's request. What cannot
 * exist in a process (installing the token usage dashboard) throws when used.
 */
export const createInferenceTaskProcessServices = ({
  core,
  logger,
  getActionsClientWithRequest,
}: {
  core: InferenceServicesCore;
  logger: Logger;
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
}): InferenceServerStart => {
  const esClient = core.elasticsearch.asInternalUser;
  const tokenUsageLogger = new TokenUsageLogger(logger);
  tokenUsageLogger.setEsClient(esClient);
  const { contract } = createInferenceServices({
    core,
    actions: {
      getActionsClientWithRequest: (request) =>
        getActionsClientWithRequest(request) as ReturnType<
          Parameters<typeof createInferenceServices>[0]['actions']['getActionsClientWithRequest']
        >,
    },
    logger: logger.get('inference'),
    // A bundle has no worker file for the pool: anonymization runs in the process.
    config: configSchema.validate({ workers: { anonymization: { enabled: false } } }),
    endpointIdCache: new InferenceEndpointIdCache({ esClient }),
    tokenUsageLogger,
  });
  return {
    ...contract,
    installTokenUsageDashboard: () => {
      throw new Error(
        'Installing the token usage dashboard is only available in Kibana, not in a task process'
      );
    },
  };
};
