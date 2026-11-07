/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, SavedObjectsBulkGetObject } from '@kbn/core/server';
import type { IEventLogService } from '@kbn/event-log-plugin/server';
import type { ActionsClient } from '../actions_client';

/** Authorizes connector event-log reads through the connector client of the requesting user. */
export const createActionsEventLogSavedObjectProvider =
  (
    getClient: (request: KibanaRequest) => Promise<Pick<ActionsClient, 'get'>>
  ): Parameters<IEventLogService['registerSavedObjectProvider']>[1] =>
  (request) => {
    const client = getClient(request);
    return (objects?: SavedObjectsBulkGetObject[]) =>
      objects
        ? Promise.all(
            objects.map(async ({ id }) => (await client).get({ id, throwIfSystemAction: false }))
          )
        : Promise.resolve([]);
  };
