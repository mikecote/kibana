/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsRepositoryMock } from '@kbn/core-saved-objects-api-server-mocks';
import { createHostTaskScheduling } from './task_scheduling';

describe('createHostTaskScheduling', () => {
  const repository = savedObjectsRepositoryMock.create();
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const scheduling = createHostTaskScheduling({
    repository,
    esClient,
    logger: loggingSystemMock.createLogger(),
    allowedTypes: /^actions:/,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repository.bulkCreate.mockImplementation((async (objects: Array<Record<string, unknown>>) => ({
      saved_objects: objects.map((o) => ({
        id: o.id,
        type: o.type,
        attributes: o.attributes,
        references: [],
      })),
    })) as never);
  });

  const instance = (overrides = {}) => ({
    taskType: 'actions:.server-log',
    params: { spaceId: 'default', actionTaskParamsId: 'p1' },
    state: {},
    scope: ['actions'],
    ...overrides,
  });

  it('writes task saved objects that run now when there is one task', async () => {
    const [task] = await scheduling.bulkSchedule([instance()]);

    expect(repository.bulkCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'task',
          id: expect.any(String),
          attributes: expect.objectContaining({
            taskType: 'actions:.server-log',
            params: JSON.stringify({ spaceId: 'default', actionTaskParamsId: 'p1' }),
            status: 'idle',
            enabled: true,
          }),
        }),
      ],
      { refresh: false }
    );
    expect(task).toEqual(
      expect.objectContaining({ taskType: 'actions:.server-log', runAt: expect.any(Date) })
    );
  });

  it.each([
    ['runAs', { runAs: { uiamApiKey: 'x' } }, /runAs/],
    ['an id', { id: 'fixed' }, /an id/],
    ['a task type it may not schedule', { taskType: 'alerting:.es-query' }, /cannot be scheduled/],
  ])('rejects %s by name', async (_name, overrides, message) => {
    await expect(scheduling.bulkSchedule([instance(overrides) as never])).rejects.toThrow(message);
    expect(repository.bulkCreate).not.toHaveBeenCalled();
  });

  it('rejects API key options', async () => {
    await expect(scheduling.bulkSchedule([instance()], { apiKey: 'k' } as never)).rejects.toThrow(
      /API key/
    );
  });

  it('throws the error of a task that could not be written', async () => {
    repository.bulkCreate.mockResolvedValueOnce({
      saved_objects: [{ id: 'a', type: 'task', error: new Error('conflict') } as never],
    });
    await expect(scheduling.bulkSchedule([instance()])).rejects.toThrow('conflict');
  });

  it('aggregates only enabled task objects', async () => {
    await scheduling.aggregate({
      query: { bool: { filter: { term: { 'task.scope': 'actions' } } } },
      aggs: {},
    });
    expect(esClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        index: '.kibana_task_manager',
        size: 0,
        query: {
          bool: {
            must: [
              expect.objectContaining({
                bool: expect.objectContaining({ filter: expect.anything() }),
              }),
              { bool: { filter: { term: { 'task.scope': 'actions' } } } },
            ],
          },
        },
      })
    );
  });
});
