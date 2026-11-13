/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { WorkflowsClient } from '@kbn/workflows/server/types';

/**
 * What the forwarder reads of the workflows extensions: the start contract in Kibana, or an adapter
 * over the engine's runtime in a task process.
 */
export interface WorkflowTriggerEmitterSource {
  getClient(request: KibanaRequest): Promise<Pick<WorkflowsClient, 'emitEvent'>>;
}

/**
 * Creates a forwarder function that emits workflow trigger events.
 * Errors from the workflow platform are caught and logged as warnings — a workflow
 * failure must never break the calling mutation.
 */
export const createWorkflowTriggerForwarder = (
  workflowsExtensions: WorkflowTriggerEmitterSource,
  logger: Pick<Logger, 'warn'>
) => {
  return async (eventType: string, payload: unknown, request: KibanaRequest): Promise<void> => {
    try {
      const client = await workflowsExtensions.getClient(request);
      await client.emitEvent(eventType, payload as Record<string, unknown>);
    } catch (error) {
      logger.warn(`Failed to emit workflow trigger "${eventType}": ${error}`);
    }
  };
};
