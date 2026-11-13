/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsRepositoryMock } from '@kbn/core-saved-objects-api-server-mocks';
import { SavedObjectsErrorHelpers } from '@kbn/core-saved-objects-server';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { coreMock, savedObjectsServiceMock, httpServerMock } from '@kbn/core/server/mocks';
import { executionContextServiceMock } from '@kbn/core-execution-context-server-mocks';
import { createInitialMiddleware } from '../../lib/middleware';
import { AdHocTaskCounter } from '../../lib/adhoc_task_counter';
import { EsApiKeyStrategy } from '../../api_key_strategy';
import { TaskSchedulingDefinitions } from '../../task_scheduling_definition_registry';
import { TaskPriority } from '../../task';
import type { StoreOpts } from '../../task_store';
import { createHostTaskScheduling } from './task_scheduling';

describe('createHostTaskScheduling', () => {
  const repository = savedObjectsRepositoryMock.create();
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const core = coreMock.createStart();
  const executionContext = executionContextServiceMock.createSetupContract();
  executionContext.withContext.mockImplementation((_context, fn) => fn());
  const definitions = new TaskSchedulingDefinitions();
  definitions.registerTaskDefinitions({
    'actions:.server-log': {},
    'workflow:run': {},
    'workflow:resume': { allowPriorityOverride: true },
    'alerting:x': {},
  });
  const baseStore: StoreOpts = {
    esClient,
    index: '.kibana_task_manager',
    taskManagerId: 'kibana:test',
    definitions,
    savedObjectsRepository: repository,
    savedObjectsService: core.savedObjects,
    serializer: savedObjectsServiceMock.createSerializer(),
    adHocTaskCounter: new AdHocTaskCounter(),
    allowReadingInvalidState: false,
    logger: loggingSystemMock.createLogger(),
    security: core.security,
    canEncryptSavedObjects: false,
    getIsSecurityEnabled: () => true,
    executionContext,
    apiKeyStrategy: new EsApiKeyStrategy(),
  };
  const scheduling = createHostTaskScheduling({
    store: baseStore,
    scheduling: { middleware: createInitialMiddleware() },
    allowedTypes: /^actions:/,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repository.bulkCreate.mockImplementation(async (objects) => ({
      saved_objects: objects.map(({ id, type, attributes }) => {
        if (!id) throw new Error('Expected the native scheduler to supply an id');
        return { id, type, attributes, references: [] };
      }),
    }));
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

  it('does not accept a request when task encryption is unavailable', async () => {
    await expect(
      scheduling.bulkSchedule([instance()], { request: httpServerMock.createKibanaRequest() })
    ).rejects.toThrow(/Encrypted Saved Objects/);
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
    const credentialCore = coreMock.createStart();
    const scopedClient = savedObjectsRepositoryMock.create();
    const internalClient = savedObjectsRepositoryMock.create();
    const savedObjects = credentialCore.savedObjects;
    const security = credentialCore.security;
    const cloneAsInternalUser = jest.spyOn(security.authc.apiKeys, 'cloneAsInternalUser');
    const request = httpServerMock.createKibanaRequest({
      headers: { authorization: 'ApiKey abc' },
    });
    const workflowTask = (overrides = {}) => ({
      id: 'workflow:exec-1:alert',
      taskType: 'workflow:run',
      params: { workflowRunId: 'exec-1', spaceId: 'default' },
      state: {},
      scope: ['workflows'],
      ...overrides,
    });

    const create = (overrides: Partial<StoreOpts> = {}) =>
      createHostTaskScheduling({
        store: {
          ...baseStore,
          savedObjectsService: savedObjects,
          security,
          apiKeyStrategy: new EsApiKeyStrategy(),
          canEncryptSavedObjects: true,
          ...overrides,
        },
        scheduling: {
          middleware: createInitialMiddleware(),
          taskPollingLifecycle: { getCurrentTasksInPool: () => ['t1::execution'] },
        },
        encryption: {
          client: encryptedSavedObjectsMock.createClient(),
          isEncryptionError: () => false,
        },
        allowedTypes: /^(?:actions:)|(?:workflow:run)$/,
      });

    beforeEach(() => {
      savedObjects.getScopedClient.mockReturnValue(scopedClient);
      savedObjects.getUnsafeInternalClient.mockReturnValue(internalClient);
      jest.spyOn(security.authc, 'getCurrentUser').mockReturnValue({
        username: 'elastic',
        roles: [],
        enabled: true,
        authentication_realm: { name: 'file', type: 'file' },
        lookup_realm: { name: 'file', type: 'file' },
        authentication_provider: { name: 'http', type: 'http' },
        authentication_type: 'api_key',
        elastic_cloud_user: false,
        http_authentication_scheme: 'apikey',
      });
      jest.spyOn(security.authc.apiKeys, 'areAPIKeysEnabled').mockResolvedValue(true);
      cloneAsInternalUser.mockResolvedValue({
        id: 'key-id',
        api_key: 'key-secret',
        name: 'n',
        encoded: Buffer.from('key-id:key-secret').toString('base64'),
      });
      scopedClient.create.mockImplementation(async (type, attributes, options) => {
        if (!options?.id) throw new Error('Expected the native scheduler to supply an id');
        return { id: options.id, type, attributes, references: [] };
      });
      scopedClient.bulkCreate.mockImplementation(async (objects) => ({
        saved_objects: objects.map(({ id, type, attributes }) => {
          if (!id) throw new Error('Expected the native scheduler to supply an id');
          return { id, type, attributes, references: [] };
        }),
      }));
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
        create({ canEncryptSavedObjects: false }).schedule(workflowTask(), { request })
      ).rejects.toThrow(/Encrypted Saved Objects/);
    });

    it('rejects a task type it may not schedule even with a request', async () => {
      await expect(
        create().schedule(workflowTask({ taskType: 'alerting:.es-query' }), { request })
      ).rejects.toThrow(/cannot be scheduled/);
    });
  });

  describe('reads, removal and rescheduling', () => {
    const notFound = (id: string) =>
      SavedObjectsErrorHelpers.createGenericNotFoundError('task', id);
    const conflict = () =>
      Object.assign(SavedObjectsErrorHelpers.createConflictError('task', 'x'), { statusCode: 409 });
    const attributes = (overrides = {}) => ({
      taskType: 'workflow:run',
      params: '{}',
      state: '{}',
      scheduledAt: '2026-01-01T00:00:00.000Z',
      runAt: '2026-01-01T00:00:00.000Z',
      status: 'idle',
      attempts: 0,
      ownerId: null,
      retryAt: null,
      startedAt: null,
      ...overrides,
    });
    const so = (id: string, overrides = {}) => ({
      id,
      type: 'task',
      version: 'v1',
      references: [],
      attributes: attributes(overrides),
    });
    const keyed = {
      apiKey: 'encrypted-key',
      userScope: { apiKeyId: 'key-id', spaceId: 'default', apiKeyCreatedByUser: false },
    };

    const encryptedClient = encryptedSavedObjectsMock.createClient();
    const invalidationClient = savedObjectsRepositoryMock.create();
    const savedObjects = coreMock.createStart().savedObjects;
    const workflows = (overrides = {}) =>
      createHostTaskScheduling({
        store: {
          ...baseStore,
          savedObjectsService: savedObjects,
          canEncryptSavedObjects: true,
          ...overrides,
        },
        scheduling: {
          middleware: createInitialMiddleware(),
          taskPollingLifecycle: { getCurrentTasksInPool: () => ['t1::execution'] },
        },
        encryption: {
          client: encryptedClient,
          isEncryptionError: () => false,
        },
        allowedTypes: /^workflow:/,
      });

    beforeEach(() => {
      savedObjects.getUnsafeInternalClient.mockReturnValue(invalidationClient);
      encryptedClient.createPointInTimeFinderDecryptedAsInternalUser.mockResolvedValue({
        close: jest.fn(),
        async *find() {
          yield {
            saved_objects: ['t1', 'a'].map((id) => ({
              ...so(id),
              score: 1,
              attributes: {
                ...attributes(),
                apiKey: Buffer.from('key-id:key-secret').toString('base64'),
              },
            })),
            total: 2,
            per_page: 100,
            page: 1,
          };
        },
      });
      invalidationClient.bulkCreate.mockResolvedValue({ saved_objects: [] });
      invalidationClient.create.mockResolvedValue({
        id: 'invalidated',
        type: 'api_key_to_invalidate',
        attributes: {},
        references: [],
      });
      repository.update.mockReset();
      repository.update.mockResolvedValue({} as never);
    });

    describe('get and bulkGet', () => {
      it('gets a task with its decrypted API key', async () => {
        repository.get.mockResolvedValue(so('t1', keyed) as never);
        const task = await workflows().get('t1');
        expect(task).toEqual(
          expect.objectContaining({
            id: 't1',
            apiKey: Buffer.from('key-id:key-secret').toString('base64'),
          })
        );
      });

      it('gets a task without keys without decrypting', async () => {
        repository.get.mockResolvedValue(so('t1') as never);
        expect((await workflows().get('t1')).id).toBe('t1');
        expect(
          encryptedClient.createPointInTimeFinderDecryptedAsInternalUser
        ).not.toHaveBeenCalled();
      });

      it('throws not found when the task does not exist', async () => {
        repository.get.mockRejectedValue(notFound('nope'));
        await expect(workflows().get('nope')).rejects.toEqual(
          expect.objectContaining({ output: expect.objectContaining({ statusCode: 404 }) })
        );
      });

      it('bulk gets results as ok or err in the order of the ids', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [
            so('a'),
            {
              id: 'b',
              type: 'task',
              error: { statusCode: 404, message: 'nf', error: 'Not Found' },
            },
          ],
        } as never);
        const [a, b] = await workflows().bulkGet(['a', 'b']);
        expect(a).toEqual({ tag: 'ok', value: expect.objectContaining({ id: 'a' }) });
        expect(b).toEqual({
          tag: 'err',
          error: { id: 'b', type: 'task', error: expect.objectContaining({ statusCode: 404 }) },
        });
      });
    });

    describe('fetch', () => {
      it('searches only task documents, sorted by runAt, and builds the result', async () => {
        esClient.search.mockResolvedValue({
          hits: {
            hits: [
              {
                _id: 'task:t1',
                _seq_no: 3,
                _primary_term: 1,
                _source: { type: 'task', task: attributes(), references: [] },
              },
              { _id: 'other:1', _source: { type: 'other', other: {} } },
            ],
          },
        } as never);
        baseStore.serializer.isRawSavedObject = (doc) => doc._source.type === 'task';
        jest.spyOn(baseStore.serializer, 'rawToSavedObject').mockReturnValue({
          id: 't1',
          type: 'task',
          references: [],
          attributes: attributes(),
          version: 'v1',
        });
        const result = await workflows().fetch({ query: { term: { 'task.scope': 'x' } } });
        expect(esClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            index: '.kibana_task_manager',
            sort: [{ 'task.runAt': 'asc' }],
            query: {
              bool: { must: [{ term: { type: 'task' } }, { term: { 'task.scope': 'x' } }] },
            },
          }),
          { retryOnTimeout: false }
        );
        expect(result.docs.map(({ id }) => id)).toEqual(['t1']);
        expect(result.versionMap.get('t1')).toEqual({ esId: 'task:t1', seqNo: 3, primaryTerm: 1 });
      });
    });

    describe('remove', () => {
      it('queues the keys of a task for invalidation, then deletes it', async () => {
        repository.get.mockResolvedValue(so('t1', keyed) as never);
        await workflows().remove('t1');
        expect(invalidationClient.bulkCreate).toHaveBeenCalledWith([
          expect.objectContaining({
            type: 'api_key_to_invalidate',
            attributes: expect.objectContaining({ apiKeyId: 'key-id' }),
          }),
        ]);
        expect(repository.delete).toHaveBeenCalledWith('task', 't1', { refresh: false });
      });

      it('deletes a task without keys and marks nothing', async () => {
        repository.get.mockResolvedValue(so('t1') as never);
        await workflows().remove('t1');
        expect(invalidationClient.bulkCreate).not.toHaveBeenCalled();
        expect(repository.delete).toHaveBeenCalled();
      });

      it('refuses a task type it may not remove', async () => {
        repository.get.mockResolvedValue(so('t1', { taskType: 'alerting:x' }) as never);
        await expect(workflows().remove('t1')).rejects.toThrow(/cannot be removed/);
        expect(repository.delete).not.toHaveBeenCalled();
      });

      it('remove throws not found, removeIfExists swallows it but not other errors', async () => {
        repository.get.mockRejectedValue(notFound('nope'));
        await expect(workflows().remove('nope')).rejects.toBeDefined();
        await expect(workflows().removeIfExists('nope')).resolves.toBeUndefined();
        repository.get.mockRejectedValue(new Error('es down'));
        await expect(workflows().removeIfExists('nope')).rejects.toThrow('es down');
      });

      it('removeIfExists removes an existing task', async () => {
        repository.get.mockResolvedValue(so('t1') as never);
        await workflows().removeIfExists('t1');
        expect(repository.delete).toHaveBeenCalledWith('task', 't1', { refresh: false });
      });
    });

    describe('bulkRemove', () => {
      it('queues the keys of every task and returns the delete result', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [
            so('a', keyed),
            so('b'),
            { id: 'c', type: 'task', error: { statusCode: 404, message: 'nf', error: 'x' } },
          ],
        } as never);
        const response = { statuses: [{ id: 'a', type: 'task', success: true }] };
        repository.bulkDelete.mockResolvedValue(response as never);
        expect(await workflows().bulkRemove(['a', 'b', 'c'])).toBe(response);
        expect(invalidationClient.bulkCreate).toHaveBeenCalledTimes(1);
        expect(repository.bulkDelete).toHaveBeenCalledWith(
          [
            { type: 'task', id: 'a' },
            { type: 'task', id: 'b' },
            { type: 'task', id: 'c' },
          ],
          { refresh: false }
        );
      });

      it('refuses, deleting nothing, when a task type may not be removed', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [so('a'), so('b', { taskType: 'alerting:x' })],
        } as never);
        await expect(workflows().bulkRemove(['a', 'b'])).rejects.toThrow(/cannot be removed/);
        expect(repository.bulkDelete).not.toHaveBeenCalled();
      });
    });

    describe('bulkUpdateSchedules', () => {
      const replyWithUpdates = () =>
        repository.bulkUpdate.mockImplementation(
          async (objects) =>
            ({
              saved_objects: objects.map((object) => ({
                ...so(object.id),
                attributes: object.attributes,
              })),
            } as never)
        );

      it('replaces an RRule schedule and moves only idle tasks unless running tasks are included', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [
            so('idle', {
              schedule: {
                rrule: { freq: 3, interval: 1, tzid: 'UTC', dtstart: '2026-01-01T00:00:00.000Z' },
              },
            }),
            so('running', { status: 'running', schedule: { interval: '1d' } }),
          ],
        } as never);
        replyWithUpdates();
        const result = await workflows().bulkUpdateSchedules(['idle', 'running'], {
          interval: '2d',
        });
        expect(result.errors).toEqual([]);
        expect(result.tasks.map(({ id }) => id)).toEqual(['idle']);
        expect(repository.bulkUpdate).toHaveBeenCalledWith(
          [
            expect.objectContaining({
              id: 'idle',
              version: 'v1',
              mergeAttributes: false,
              attributes: expect.objectContaining({ schedule: { interval: '2d' } }),
            }),
          ],
          { refresh: false }
        );
      });

      it('preserves the due time of a running task while updating its schedule', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [so('running', { status: 'running', schedule: { interval: '1d' } })],
        } as never);
        replyWithUpdates();
        const result = await workflows().bulkUpdateSchedules(
          ['running'],
          { interval: '2d' },
          { includeRunningTasks: true }
        );
        expect(result.tasks[0].runAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(result.tasks[0].schedule).toEqual({ interval: '2d' });
      });

      it('retries version conflicts against the latest task version', async () => {
        repository.bulkGet.mockResolvedValueOnce({
          saved_objects: [so('idle', { schedule: { interval: '1d' } })],
        });
        repository.bulkGet
          .mockResolvedValueOnce({
            saved_objects: [so('idle', { schedule: { interval: '1d' } })],
          } as never)
          .mockResolvedValueOnce({
            saved_objects: [{ ...so('idle', { schedule: { interval: '1d' } }), version: 'v2' }],
          } as never);
        replyWithUpdates();
        repository.bulkUpdate.mockResolvedValueOnce({
          saved_objects: [
            {
              id: 'idle',
              type: 'task',
              error: { statusCode: 409, message: 'conflict', error: 'Conflict' },
            },
          ],
        });
        const result = await workflows().bulkUpdateSchedules(['idle'], { interval: '2d' });
        expect(result.errors).toEqual([]);
        expect(repository.bulkUpdate).toHaveBeenLastCalledWith(
          [expect.objectContaining({ version: 'v2' })],
          { refresh: false }
        );
      });

      it('rejects writes outside the allowed task types', async () => {
        repository.bulkGet.mockResolvedValue({
          saved_objects: [so('rule', { taskType: 'alerting:x' })],
        } as never);
        await expect(workflows().bulkUpdateSchedules(['rule'], { interval: '2d' })).rejects.toThrow(
          'cannot be rescheduled'
        );
        expect(repository.bulkUpdate).not.toHaveBeenCalled();
      });
    });

    describe('runSoon', () => {
      it('sets runAt to now and keeps retryAt, at the version that was read', async () => {
        repository.get.mockResolvedValue(so('t1', { runAt: '2999-01-01T00:00:00.000Z' }) as never);
        const result = await workflows().runSoon('t1');
        expect(result).toEqual({ id: 't1', forced: false });
        const [, , attrs, options] = repository.update.mock.calls[0];
        expect(attrs).toEqual(
          expect.objectContaining({
            status: 'idle',
            scheduledAt: expect.any(String),
            runAt: expect.any(String),
          })
        );
        expect(new Date((attrs as { runAt: string }).runAt).getTime()).toBeLessThanOrEqual(
          Date.now()
        );
        expect(options).toEqual(expect.objectContaining({ version: 'v1', refresh: false }));
      });

      it('sets the priority when given', async () => {
        repository.get.mockResolvedValue(so('t1', { taskType: 'workflow:resume' }));
        await workflows().runSoon('t1', { priority: TaskPriority.Normal });
        expect(repository.update).toHaveBeenCalledWith(
          'task',
          't1',
          expect.objectContaining({ priority: TaskPriority.Normal }),
          expect.anything()
        );
      });

      it.each([
        ['running', 'running', undefined, /currently running$/],
        ['running with force', 'running', true, /cannot be forced/],
        ['claiming', 'claiming', undefined, /currently running/],
      ])('throws for a %s task', async (_n, status, force, message) => {
        repository.get.mockResolvedValue(so('t1', { status }) as never);
        await expect(workflows().runSoon('t1', force)).rejects.toThrow(message);
        expect(repository.update).not.toHaveBeenCalled();
      });

      it('throws for an unrecognized task, a type it may not touch and an unknown task', async () => {
        repository.get.mockResolvedValue(so('t1', { status: 'unrecognized' }) as never);
        await expect(workflows().runSoon('t1')).rejects.toThrow(/Failed to run task "t1"/);
        repository.get.mockResolvedValue(so('t1', { taskType: 'alerting:x' }) as never);
        await expect(workflows().runSoon('t1')).rejects.toThrow(/cannot be run soon/);
        repository.get.mockRejectedValue(notFound('t1'));
        await expect(workflows().runSoon('t1')).rejects.toBeDefined();
      });

      it('reports a version conflict instead of throwing', async () => {
        repository.get.mockResolvedValue(so('t1') as never);
        repository.update.mockRejectedValue(conflict());
        expect(await workflows().runSoon('t1')).toEqual({
          id: 't1',
          forced: false,
          conflict: true,
        });
      });

      it('throws other update errors', async () => {
        repository.get.mockResolvedValue(so('t1') as never);
        repository.update.mockRejectedValue(new Error('es down'));
        await expect(workflows().runSoon('t1')).rejects.toThrow('es down');
      });
    });

    describe('ensureScheduled', () => {
      const task = (overrides = {}) => ({
        id: 'workflow:1',
        taskType: 'workflow:run',
        params: {},
        state: {},
        schedule: { interval: '5m' },
        ...overrides,
      });
      const replyWithExistingSchedule = () =>
        repository.bulkUpdate.mockImplementation(async (objects) => ({
          saved_objects: objects.map((object) => ({
            ...so(object.id),
            attributes: { ...attributes(), ...object.attributes },
          })),
        }));
      beforeEach(() => {
        repository.bulkGet.mockImplementation(async () => ({
          saved_objects: [await repository.get('task', 'workflow:1')],
        }));
        replyWithExistingSchedule();
        repository.create.mockImplementation((async (type: string, attrs: unknown, o: never) => ({
          id: (o as { id: string }).id,
          type,
          attributes: attrs,
          references: [],
        })) as never);
      });

      it('schedules a task that does not exist', async () => {
        const scheduled = await workflows().ensureScheduled(task());
        expect(scheduled.id).toBe('workflow:1');
        expect(repository.create).toHaveBeenCalledWith('task', expect.anything(), {
          id: 'workflow:1',
          refresh: false,
        });
      });

      it('updates the interval of an existing task on conflict', async () => {
        repository.create.mockRejectedValue(conflict());
        repository.get.mockResolvedValue(
          so('workflow:1', { schedule: { interval: '1m' }, taskType: 'workflow:run' }) as never
        );
        await workflows().ensureScheduled(task());
        expect(repository.bulkUpdate).toHaveBeenCalledWith(
          [
            expect.objectContaining({
              id: 'workflow:1',
              attributes: expect.objectContaining({ schedule: { interval: '5m' } }),
            }),
          ],
          { refresh: false }
        );
      });

      it('leaves an existing task with the same schedule or without an interval alone', async () => {
        repository.create.mockRejectedValue(conflict());
        repository.get.mockResolvedValue(
          so('workflow:1', { schedule: { interval: '5m' } }) as never
        );
        await workflows().ensureScheduled(task());
        await workflows().ensureScheduled(task({ schedule: undefined }));
        expect(repository.update).not.toHaveBeenCalled();
      });

      it('rethrows other errors and refuses types it may not schedule', async () => {
        repository.create.mockRejectedValue(new Error('es down'));
        await expect(workflows().ensureScheduled(task())).rejects.toThrow('es down');
        await expect(workflows().ensureScheduled(task({ taskType: 'alerting:x' }))).rejects.toThrow(
          /cannot be scheduled/
        );
      });

      it('does not grant API keys for an id that already exists', async () => {
        const security = coreMock.createStart().security;
        const cloneAsInternalUser = jest.spyOn(security.authc.apiKeys, 'cloneAsInternalUser');
        repository.get.mockResolvedValue(
          so('workflow:1', { schedule: { interval: '1m' } }) as never
        );
        const withKeys = workflows({ security });
        await withKeys.ensureScheduled(task(), {
          request: httpServerMock.createKibanaRequest(),
          cloneApiKey: true,
        });
        expect(cloneAsInternalUser).not.toHaveBeenCalled();
        expect(repository.create).not.toHaveBeenCalled();
        expect(repository.bulkUpdate).toHaveBeenCalledWith(
          [
            expect.objectContaining({
              id: 'workflow:1',
              attributes: expect.objectContaining({ schedule: { interval: '5m' } }),
            }),
          ],
          { refresh: false }
        );
      });
    });
  });
});
