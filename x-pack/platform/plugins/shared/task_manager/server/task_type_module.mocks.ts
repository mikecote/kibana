/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import type { TaskHost } from './task_type_module';

/** A host whose services are all mocks; pass overrides for the ones a test drives. */
export const createTaskHostMock = (overrides: Partial<TaskHost> = {}): TaskHost => ({
  logger: loggingSystemMock.createLogger(),
  elasticsearch: elasticsearchServiceMock.createStart().client,
  savedObjects: savedObjectsServiceMock.createStartContract(),
  executionContext: { withContext: (_context, fn) => fn(), getAsLabels: () => ({}) },
  security: { authc: { getCurrentUser: () => null }, audit: {} } as unknown as TaskHost['security'],
  server: { uuid: 'test-uuid', version: '9.9.9', buildNum: 1, isServerless: false },
  ...overrides,
});
