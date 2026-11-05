/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isNotFoundError } from '@kbn/es-errors';
import type { WorkflowDetailDto } from '@kbn/workflows';
import { buildWorkflowFilters } from '@kbn/workflows/server';
import type { WorkflowStorageDeps } from './types';
import { transformStorageDocumentToWorkflowDto } from '../api/lib/workflow_dto_transform';
import type { WorkflowProperties } from '../storage/workflow_storage';

/**
 * Reads one workflow from storage. It needs the storage and a logger and nothing else, so the CRUD
 * service delegates its reads to it and a task process builds it from the same storage definition.
 */
export class WorkflowReadService {
  constructor(private readonly deps: WorkflowStorageDeps) {}

  async getWorkflowDocumentSource(
    id: string,
    spaceId: string,
    options?: { includeDeleted?: boolean; includeGlobal?: boolean }
  ): Promise<WorkflowProperties | null> {
    const { must, must_not } = buildWorkflowFilters({
      ids: [id],
      space: { id: spaceId, includeGlobal: options?.includeGlobal },
      deleted: options?.includeDeleted ? 'all' : 'not_deleted',
    });
    const searchResponse = await this.deps.workflowStorage.getClient().search({
      query: { bool: { must, must_not } },
      size: 1,
      track_total_hits: false,
      allow_partial_search_results: false,
    });
    if (searchResponse.timed_out) {
      throw new Error('Could not determine workflow access from an incomplete search.');
    }

    const hit = searchResponse.hits.hits[0];
    return (hit?._source as WorkflowProperties | undefined) ?? null;
  }

  async getWorkflow(
    id: string,
    spaceId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<WorkflowDetailDto | null> {
    try {
      const source = await this.getWorkflowDocumentSource(id, spaceId, {
        includeDeleted: options?.includeDeleted ?? false,
        includeGlobal: true,
      });
      if (!source) {
        return null;
      }
      return transformStorageDocumentToWorkflowDto(id, source);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }
}
