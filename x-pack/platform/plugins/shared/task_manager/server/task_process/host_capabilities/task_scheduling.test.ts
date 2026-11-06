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
      { refresh: false, overwrite: false }
    );
    expect(task).toEqual(
      expect.objectContaining({ taskType: 'actions:.server-log', runAt: expect.any(Date) })
    );
  });

  it.each([
    ['runAs', { runAs: { uiamApiKey: 'x' } }, /runAs/],
    ['a task type it may not schedule', { taskType: 'alerting:.es-query' }, /cannot be scheduled/],
  ])('rejects %s by name', async (_name, overrides, message) => {
    await expect(scheduling.bulkSchedule([instance(overrides) as never])).rejects.toThrow(message);
    expect(repository.bulkCreate).not.toHaveBeenCalled();
  });

  it('rejects a legacy apiKey option and a request without credentials', async () => {
    await expect(scheduling.bulkSchedule([instance()], { apiKey: 'k' } as never)).rejects.toThrow(
      /apiKey/
    );
    await expect(scheduling.bulkSchedule([instance()], { request: {} } as never)).rejects.toThrow(
      /credentials/
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

  describe('with credentials', () => {
    const scopedClient = { create: jest.fn(), bulkCreate: jest.fn() };
    const internalClient = {};
    const grantAsInternalUser = jest.fn();
    const cloneAsInternalUser = jest.fn();
    const savedObjects = {
      getScopedClient: jest.fn(() => scopedClient),
      getUnsafeInternalClient: jest.fn(() => internalClient),
    };
    const security = {
      authc: {
        getCurrentUser: jest.fn(() => ({ username: 'elastic', authentication_type: 'api_key' })),
        apiKeys: {
          areAPIKeysEnabled: jest.fn(async () => true),
          grantAsInternalUser,
          cloneAsInternalUser,
          invalidateAsInternalUser: jest.fn(),
        },
      },
    };
    const request = { headers: { authorization: 'ApiKey abc' } } as never;
    const workflowTask = (overrides = {}) => ({
      id: 'workflow:exec-1:alert',
      taskType: 'workflow:run',
      params: { workflowRunId: 'exec-1', spaceId: 'default' },
      state: {},
      scope: ['workflows'],
      ...overrides,
    });

    const create = (overrides: Record<string, unknown> = {}) =>
      createHostTaskScheduling({
        repository,
        esClient,
        logger: loggingSystemMock.createLogger(),
        allowedTypes: /^(?:actions:)|(?:workflow:run)$/,
        credentials: {
          savedObjects: savedObjects as never,
          security: security as never,
          apiKeyType: 'es' as never,
          grantUiamApiKeys: false,
          canEncrypt: true,
          ...overrides,
        },
      });

    beforeEach(() => {
      cloneAsInternalUser.mockResolvedValue({ id: 'key-id', api_key: 'key-secret', name: 'n' });
      scopedClient.create.mockImplementation(async (type, attributes, options) => ({
        id: options.id,
        type,
        attributes,
        references: [],
      }));
      scopedClient.bulkCreate.mockImplementation(
        async (objects: Array<Record<string, unknown>>) => ({
          saved_objects: objects.map((o) => ({ ...o, references: [] })),
        })
      );
      repository.bulkGet.mockResolvedValue({ saved_objects: [] } as never);
    });

    it('writes the credential of the request with the client that encrypts it', async () => {
      const task = await create().schedule(workflowTask(), { request, cloneApiKey: true });

      expect(cloneAsInternalUser).toHaveBeenCalledTimes(1);
      expect(savedObjects.getScopedClient).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ includedHiddenTypes: ['task'] })
      );
      expect(scopedClient.create).toHaveBeenCalledWith(
        'task',
        expect.objectContaining({
          taskType: 'workflow:run',
          apiKey: expect.any(String),
          userScope: expect.objectContaining({ apiKeyId: 'key-id' }),
        }),
        { id: 'workflow:exec-1:alert', refresh: false }
      );
      expect(task.id).toBe('workflow:exec-1:alert');
      expect(repository.bulkCreate).not.toHaveBeenCalled();
    });

    it('bulk schedules with a credential and an explicit id', async () => {
      const [task] = await create().bulkSchedule([workflowTask()], { request, cloneApiKey: true });

      expect(scopedClient.bulkCreate).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            type: 'task',
            id: 'workflow:exec-1:alert',
            attributes: expect.objectContaining({ apiKey: expect.any(String) }),
          }),
        ],
        { refresh: false, overwrite: false }
      );
      expect(task.id).toBe('workflow:exec-1:alert');
    });

    it('does not overwrite a task that has a credential', async () => {
      repository.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            id: 'workflow:exec-1:alert',
            type: 'task',
            version: 'v1',
            attributes: { credential: { type: 'service_account' } },
          },
        ],
      } as never);

      await expect(
        create().bulkSchedule([workflowTask()], { request, cloneApiKey: true })
      ).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));
      expect(scopedClient.bulkCreate).not.toHaveBeenCalled();
    });

    it('refuses to schedule with a request when it cannot encrypt', async () => {
      await expect(
        create({ canEncrypt: false }).schedule(workflowTask(), { request })
      ).rejects.toThrow(/Encrypted Saved Objects/);
    });

    it('rejects a task type it may not schedule even with a request', async () => {
      await expect(
        create().schedule(workflowTask({ taskType: 'alerting:.es-query' }), { request })
      ).rejects.toThrow(/cannot be scheduled/);
    });
  });
});
