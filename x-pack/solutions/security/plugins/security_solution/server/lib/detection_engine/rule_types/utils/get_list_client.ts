/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, SavedObjectsClientContract } from '@kbn/core/server';
import type { ExceptionListClient, ListClient } from '@kbn/lists-plugin/server';
import type { RuleRunLists } from '../types';

export const getListClient = ({
  lists,
  spaceId,
  updatedByUser,
  esClient,
  savedObjectClient,
}: {
  lists: RuleRunLists | undefined;
  spaceId: string;
  updatedByUser: string | null;
  esClient: ElasticsearchClient;
  savedObjectClient: SavedObjectsClientContract;
}): {
  listClient: ListClient;
  exceptionsClient: ExceptionListClient;
} => {
  if (lists == null) {
    throw new Error('lists plugin unavailable during rule execution');
  }

  const listClient = lists.getListClient(esClient, spaceId, updatedByUser ?? 'elastic');
  const exceptionsClient = lists.getExceptionListClient(
    savedObjectClient,
    updatedByUser ?? 'elastic'
  );

  return { listClient, exceptionsClient };
};
