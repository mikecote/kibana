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
import type { DashboardServerClient } from './types';

/**
 * The dashboard client of the plugin's start contract. The plugin's `start()` and a task process call
 * it (the process after `setReadOnlyKibanaServices`).
 */
export const createDashboardServerClient = (): DashboardServerClient => {
  // Do not call getDashboardStateSchema when registering: plugins register embeddable schemas until
  // all of them are set up, so the schema is built the first time the client is used.
  const getCachedDashboardStateSchema = once(() => getDashboardStateSchema(false));
  return {
    read: async (savedObjectsClient: SavedObjectsClientContract, id: string) =>
      (await read(savedObjectsClient, getCachedDashboardStateSchema(), id)).body,
  };
};
