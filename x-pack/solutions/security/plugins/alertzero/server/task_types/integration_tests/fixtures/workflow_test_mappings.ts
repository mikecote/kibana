/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Client } from '@elastic/elasticsearch';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { workflowStorageSettings } from '@kbn/workflows-management-plugin/server';

export const extendWorkflowTestMappings = async (es: Pick<Client, 'indices'>): Promise<void> => {
  const mappings = await es.indices.getMapping({ index: WORKFLOW_INDEX_NAME });
  const existing = mappings[WORKFLOW_INDEX_NAME].mappings.properties ?? {};
  await es.indices.putMapping({
    index: WORKFLOW_INDEX_NAME,
    properties: Object.fromEntries(
      Object.entries(workflowStorageSettings.schema.properties).filter(
        ([field]) => !Object.hasOwn(existing, field)
      )
    ),
  });
};
