/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { KibanaRequest } from '@kbn/core-http-server';
import { ResourceTypes } from '@kbn/product-doc-common';
import type { ResourceType } from '@kbn/product-doc-common';
import type { LlmTasksPluginStart } from './types';
import { retrieveDocumentation } from './tasks';
import type { RetrieveDocumentationAPI } from './tasks/retrieve_documentation';

type SearchDocAPI = Parameters<typeof retrieveDocumentation>[0]['searchDocAPI'];
type OutputAPI = Parameters<typeof retrieveDocumentation>[0]['outputAPI'];

/**
 * What the LLM tasks read, as the plugin's dependencies have it: the inference client of a request and
 * the product documentation (search and installation status).
 */
export interface LlmTasksServices {
  inference: { getClient: (options: { request: KibanaRequest }) => { output: OutputAPI } };
  productDocBase: {
    search: SearchDocAPI;
    management: {
      getStatus: (options: { inferenceId: string }) => Promise<{ status: string }>;
      getSecurityLabsStatus: (options: { inferenceId: string }) => Promise<{ status: string }>;
    };
  };
  logger: Logger;
}

/**
 * The start contract of the LLM tasks plugin, built from explicit dependencies: the plugin's `start()`
 * calls it with its start dependencies and a task process with the services of its host.
 */
export const createLlmTasksStartContract = ({
  inference,
  productDocBase,
  logger,
}: LlmTasksServices): LlmTasksPluginStart => ({
  retrieveDocumentationAvailable: async (options: {
    inferenceId: string;
    resourceType?: ResourceType;
  }) => {
    try {
      const resourceType = options.resourceType ?? ResourceTypes.productDoc;
      const status =
        resourceType === ResourceTypes.securityLabs
          ? await productDocBase.management.getSecurityLabsStatus({
              inferenceId: options.inferenceId,
            })
          : await productDocBase.management.getStatus({ inferenceId: options.inferenceId });
      return status.status === 'installed';
    } catch {
      return false;
    }
  },
  retrieveDocumentation: ((options) =>
    retrieveDocumentation({
      outputAPI: inference.getClient({ request: options.request }).output,
      searchDocAPI: productDocBase.search,
      logger: logger.get('tasks.retrieve-documentation'),
    })(options)) as RetrieveDocumentationAPI,
});
