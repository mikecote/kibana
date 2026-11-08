/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import { SavedObjectsErrorHelpers } from '@kbn/core/server';
import { loggerMock } from '@kbn/logging-mocks';
import { taskManagerMock } from '@kbn/task-manager-plugin/server/mocks';
import { EntityMaintainerTaskStatus } from './tasks/entity_maintainers/types';
import { createEntityStoreClientServices } from './create_entity_store_client_services';

it('isolates registered maintainer status and task namespaces between native SDK instances', async () => {
  const taskManager = taskManagerMock.createStart();
  taskManager.get.mockImplementation(async (id) =>
    taskManagerMock.createTask({
      id,
      state: {
        taskStatus: EntityMaintainerTaskStatus.STARTED,
        metadata: { lastSuccessTimestamp: id },
        state: {},
      },
    })
  );
  const build = (id: string) =>
    createEntityStoreClientServices({
      logger: loggerMock.create(),
      analytics: coreMock.createStart().analytics,
      taskManager,
      getMaintainers: () => [{ id, interval: '1m', minLicense: 'basic' }],
    });
  const first = build('security-risk-score');
  const second = build('resolution');
  const [firstStatus, secondStatus] = await Promise.all([
    first.getMaintainerStatus('space-a'),
    second.getMaintainerStatus('space-b'),
  ]);
  expect(firstStatus).toEqual([
    {
      id: 'security-risk-score',
      taskStatus: EntityMaintainerTaskStatus.STARTED,
      lastSuccessTimestamp: 'security-risk-score:space-a',
    },
  ]);
  expect(secondStatus).toEqual([
    {
      id: 'resolution',
      taskStatus: EntityMaintainerTaskStatus.STARTED,
      lastSuccessTimestamp: 'resolution:space-b',
    },
  ]);
  expect(await first.getMaintainerStatus('space-a', ['resolution'])).toEqual([]);
  expect(taskManager.get).toHaveBeenCalledTimes(2);
});

it('reports a registered but unscheduled maintainer without losing the Main registration', async () => {
  const taskManager = taskManagerMock.createStart();
  taskManager.get.mockRejectedValue(
    SavedObjectsErrorHelpers.createGenericNotFoundError('task', 'risk:default')
  );
  const services = createEntityStoreClientServices({
    logger: loggerMock.create(),
    analytics: coreMock.createStart().analytics,
    taskManager,
    getMaintainers: () => [{ id: 'risk', interval: '1m', minLicense: 'basic' }],
  });
  expect(await services.getMaintainerStatus('default')).toEqual([
    {
      id: 'risk',
      taskStatus: EntityMaintainerTaskStatus.NEVER_STARTED,
      lastSuccessTimestamp: null,
    },
  ]);
});
