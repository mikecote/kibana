/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { once } from 'lodash';
import type { SavedObjectsClientContract } from '@kbn/core/server';
import { read } from './api';
import { getDashboardStateSchema } from './api/dashboard_state_schemas';
import { withDashboardReadServices } from './dashboard_read_services';
import type { DashboardReadServices } from './dashboard_read_services';
import type { DashboardServerClient } from './types';

/** Builds the dashboard client with native services scoped to each asynchronous read. */
export const createDashboardServerClient = (
  services?: DashboardReadServices
): DashboardServerClient => {
  // Do not call getDashboardStateSchema when registering: plugins register embeddable schemas until
  // all of them are set up, so the schema is built the first time the client is used.
  const getCachedDashboardStateSchema = once(() => getDashboardStateSchema(false));
  const readDashboard = async (savedObjectsClient: SavedObjectsClientContract, id: string) =>
    (await read(savedObjectsClient, getCachedDashboardStateSchema(), id)).body;
  return {
    read: (savedObjectsClient, id) =>
      services
        ? withDashboardReadServices(services, () => readDashboard(savedObjectsClient, id))
        : readDashboard(savedObjectsClient, id),
  };
};
