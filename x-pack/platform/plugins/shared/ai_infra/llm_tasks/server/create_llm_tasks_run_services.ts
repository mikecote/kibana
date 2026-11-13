/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createProductDocReadServices } from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import type { Logger } from '@kbn/logging';
import { createLlmTasksStartContract } from './create_llm_tasks_start_contract';
import type { LlmTasksServices } from './create_llm_tasks_start_contract';
import type { LlmTasksPluginStart } from './types';

type LlmTasksRunServicesDeps = Parameters<typeof createProductDocReadServices>[0] & {
  inference: LlmTasksServices['inference'];
  documentationLogger: Logger;
};

/** Builds native documentation tasks from the owning search, installation and inference services. */
export const createLlmTasksRunServices = ({
  inference,
  logger,
  documentationLogger,
  ...deps
}: LlmTasksRunServicesDeps): LlmTasksPluginStart => {
  const documentation = createProductDocReadServices({ ...deps, logger: documentationLogger });
  return createLlmTasksStartContract({
    inference,
    productDocBase: { search: documentation.search, management: documentation },
    logger,
  });
};
