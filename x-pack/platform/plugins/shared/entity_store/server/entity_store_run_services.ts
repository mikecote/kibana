/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { CRUDClient } from './domain/crud';
import { createWorkflowTriggerEmitter } from './workflow/create_workflow_trigger_emitter';
import type { EntityStoreStartContract } from './types';

/** What a rule run reads of the entity store: the client that writes entities. */
export type EntityStoreRunServices = Pick<EntityStoreStartContract, 'createCRUDClient'>;

/**
 * The entity store's CRUD client factory, from explicit dependencies: the plugin builds its start
 * contract with it, and a task process hands it to the rule types that update entities.
 */
export const createEntityStoreRunServices = ({
  logger,
}: {
  logger: Logger;
}): EntityStoreRunServices => ({
  createCRUDClient: (esClient, namespace, getWorkflowsClient) => {
    const emitWorkflowTriggerEvent = getWorkflowsClient
      ? createWorkflowTriggerEmitter({
          getWorkflowsClient,
          logger,
          context: `namespace "${namespace}"`,
        })
      : undefined;
    return new CRUDClient({ logger, esClient, namespace, emitWorkflowTriggerEvent });
  },
});
