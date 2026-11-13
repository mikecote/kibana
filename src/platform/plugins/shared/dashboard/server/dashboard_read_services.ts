/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Logger } from '@kbn/logging';
import type { EmbeddableStart } from '@kbn/embeddable-plugin/server';
import * as kibanaServices from './kibana_services';

export interface DashboardReadServices {
  embeddable: EmbeddableStart;
  logger: Logger;
}

const storage = new AsyncLocalStorage<DashboardReadServices>();

/** Resolves the native services of this read or the services initialized by the dashboard plugin. */
export const getDashboardReadServices = (): DashboardReadServices =>
  storage.getStore() ?? {
    embeddable: kibanaServices.embeddableService,
    logger: kibanaServices.logger,
  };

/** Isolates the native services used by every asynchronous operation in a dashboard read. */
export const withDashboardReadServices = <T>(services: DashboardReadServices, read: () => T): T =>
  storage.run(services, read);
