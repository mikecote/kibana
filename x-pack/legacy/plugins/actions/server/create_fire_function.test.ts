/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { taskManagerMock } from '../../task_manager/task_manager.mock';
import { createFireFunction } from './create_fire_function';
import { SavedObjectsClientMock } from '../../../../../src/core/server/mocks';

const mockTaskManager = taskManagerMock.create();
const savedObjectsClient = SavedObjectsClientMock.create();
const spaceIdToNamespace = jest.fn();

beforeEach(() => jest.resetAllMocks());

describe('fire()', () => {
  test('schedules the action with all given parameters', async () => {
    const fireFn = createFireFunction({
      taskManager: mockTaskManager,
      internalSavedObjectsRepository: savedObjectsClient,
      spaceIdToNamespace,
    });
    savedObjectsClient.get.mockResolvedValueOnce({
      id: '123',
      type: 'action',
      attributes: {
        actionTypeId: 'mock-action',
      },
      references: [],
    });
    spaceIdToNamespace.mockReturnValueOnce('namespace1');
    await fireFn({
      id: '123',
      params: { baz: false },
      spaceId: 'default',
      source: {
        type: 'alert',
        id: '123',
      },
    });
    expect(mockTaskManager.schedule).toHaveBeenCalledTimes(1);
    expect(mockTaskManager.schedule.mock.calls[0]).toMatchInlineSnapshot(`
      Array [
        Object {
          "params": Object {
            "actionTypeParams": Object {
              "baz": false,
            },
            "id": "123",
            "source": Object {
              "id": "123",
              "type": "alert",
            },
            "spaceId": "default",
          },
          "scope": Array [
            "actions",
          ],
          "state": Object {},
          "taskType": "actions:mock-action",
        },
      ]
    `);
    expect(spaceIdToNamespace).toHaveBeenCalledWith('default');
    expect(savedObjectsClient.get).toHaveBeenCalledWith('action', '123', {
      namespace: 'namespace1',
    });
  });
});
