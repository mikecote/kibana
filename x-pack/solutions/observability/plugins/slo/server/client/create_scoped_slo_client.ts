/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { CoreStart, KibanaRequest, Logger } from '@kbn/core/server';
import type { SLOServerStart } from '../types';
import { getSloClientWithRequest } from '.';

export interface ScopedSloClientDependencies {
  savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
  elasticsearch: Pick<CoreStart['elasticsearch'], 'client'>;
  getSpaceId: (request: KibanaRequest) => Promise<string>;
  logger: Logger;
}

/** Creates request-scoped native SLO clients with the executing user's saved object and ES access. */
export const createScopedSloClient =
  ({
    savedObjects,
    elasticsearch,
    getSpaceId,
    logger,
  }: ScopedSloClientDependencies): SLOServerStart['getSloClientWithRequest'] =>
  async (request) => {
    const spaceId = await getSpaceId(request);
    return getSloClientWithRequest({
      request,
      soClient: savedObjects.getScopedClient(request),
      esClient: elasticsearch.client.asInternalUser,
      scopedClusterClient: elasticsearch.client.asScoped(request),
      spaceId,
      logger,
    });
  };
