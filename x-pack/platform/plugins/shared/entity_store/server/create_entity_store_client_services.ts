/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceStart, Logger } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import { EntityMetadataClient } from './domain/entity_metadata';
import { RelationshipsClient } from './domain/relationships';
import { ResolutionClient } from './domain/resolution';
import { ResolutionRulesClient } from './domain/resolution/rules';
import { getMaintainerStatus } from './domain/entity_maintainers';
import { createReportEvent } from './telemetry/events';
import type { EntityMaintainerTaskEntry } from './tasks/entity_maintainers/types';
import type { EntityStoreStartContract } from './types';

export const ENTITY_STORE_RUNTIME_SETTINGS_ID = 'entityStoreRuntime';

export interface EntityStoreRuntimeSettings {
  maintainers: readonly EntityMaintainerTaskEntry[];
}

export type EntityStoreClientServices = Pick<
  EntityStoreStartContract,
  | 'createEntityMetadataClient'
  | 'createRelationshipsClient'
  | 'createResolutionClient'
  | 'createResolutionRulesClient'
  | 'getMaintainerStatus'
>;

/** Builds native entity relationships, resolution and status clients for Main and task workers. */
export const createEntityStoreClientServices = ({
  logger,
  analytics,
  taskManager,
  getMaintainers,
}: {
  logger: Logger;
  analytics: Pick<AnalyticsServiceStart, 'reportEvent'>;
  taskManager: Pick<TaskManagerStartContract, 'get'>;
  getMaintainers: () => readonly EntityMaintainerTaskEntry[];
}): EntityStoreClientServices => ({
  createEntityMetadataClient: (esClient, namespace) =>
    new EntityMetadataClient({ logger, esClient, namespace }),
  createRelationshipsClient: (esClient, namespace) =>
    new RelationshipsClient({ logger, esClient, namespace }),
  createResolutionClient: (esClient, namespace) =>
    new ResolutionClient({ logger, esClient, namespace, analytics: createReportEvent(analytics) }),
  createResolutionRulesClient: (savedObjectsClient, namespace) =>
    new ResolutionRulesClient(savedObjectsClient, namespace, logger),
  getMaintainerStatus: (namespace, ids) =>
    getMaintainerStatus({
      taskManager,
      namespace,
      logger,
      ids,
      registeredMaintainers: getMaintainers(),
    }),
});
