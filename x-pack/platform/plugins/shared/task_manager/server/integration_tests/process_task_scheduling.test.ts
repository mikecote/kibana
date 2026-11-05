/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Client } from '@elastic/elasticsearch';
import { kibanaPackageJson } from '@kbn/repo-info';
import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { elasticsearchConfigFromEnv } from '../task_process/es_config';
import { startTaskProcessCore } from '../task_process/core_process';
import type { TaskProcessCore } from '../task_process/core_process';
import {
  createHostTaskScheduling,
  TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS,
} from '../task_process/host_capabilities/task_scheduling';
import type { HostTaskManager } from '../task_process/host_capabilities/task_scheduling';
import { defineTaskType } from '../task_type_module';
import { apiKeyToInvalidateMappings, taskMappings } from '../saved_objects/mappings';

const KIBANA_VERSION = kibanaPackageJson.version;
const TASK_INDEX = '.kibana_task_manager';

/**
 * `host.taskManager` of a task process against a real Elasticsearch: the task documents it writes,
 * reads, updates and removes, with the credential of a request encrypted by the encrypted saved objects
 * plugin of the process. The security plugin is not part of the process here, so the stand-in below
 * grants the keys it would (a real Elasticsearch API key per task type, as `cloneAsInternalUser` does).
 */
describe('task scheduling of a task process', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let core: TaskProcessCore;
  let taskManager: HostTaskManager;
  let request: ReturnType<typeof kibanaRequestFactory>;
  let apiKeysCreated: string[];

  const refresh = () => es.indices.refresh({ index: TASK_INDEX });
  const invalidationDocs = async () => {
    await refresh();
    const { hits } = await es.search<{ api_key_to_invalidate: { apiKeyId: string } }>({
      index: TASK_INDEX,
      query: { term: { type: 'api_key_to_invalidate' } },
      size: 100,
    });
    return hits.hits.map((hit) => hit._source!.api_key_to_invalidate.apiKeyId);
  };
  const workflowTask = (id: string, overrides = {}) => ({
    id,
    taskType: 'workflow:run',
    params: { executionId: id },
    state: {},
    scope: ['workflows'],
    ...overrides,
  });

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();

    await es.indices.create({
      index: `${TASK_INDEX}_${KIBANA_VERSION}_001`,
      aliases: { [TASK_INDEX]: {}, [`${TASK_INDEX}_${KIBANA_VERSION}`]: {} },
      mappings: {
        dynamic: false,
        properties: {
          type: { type: 'keyword' },
          namespace: { type: 'keyword' },
          namespaces: { type: 'keyword' },
          updated_at: { type: 'date' },
          references: {
            type: 'nested',
            properties: {
              name: { type: 'keyword' },
              type: { type: 'keyword' },
              id: { type: 'keyword' },
            },
          },
          task: { properties: taskMappings.properties },
          api_key_to_invalidate: { properties: apiKeyToInvalidateMappings.properties },
        },
      } as never,
    });

    core = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: elasticsearchConfigFromEnv({
          ES_URL: esServer.hosts[0],
          ES_USERNAME: esServer.username,
          ES_PASSWORD: esServer.password,
        }),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        server: { uuid: '5b2de169-2785-441b-ae8c-186a1936b17d', buildNum: 1, isServerless: false },
        encryptedSavedObjects: { encryptionKey: 'a'.repeat(32), decryptionOnlyKeys: [] },
      },
      module: defineTaskType({
        type: 'workflow:test',
        title: 'Task scheduling',
        taskManager: { schedulableTypes: [/^workflow:/] },
        encryptedSavedObjectTypes: TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS,
        createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
      }),
    });

    apiKeysCreated = [];
    const { host } = core;
    // The part of the security plugin that grants the key of a task: a real key, owned by Task Manager.
    const security = {
      authc: {
        getCurrentUser: () => ({ username: 'elastic', authentication_type: 'api_key' }),
        apiKeys: {
          areAPIKeysEnabled: async () => true,
          cloneAsInternalUser: async (_request: unknown, { name }: { name: string }) => {
            const key = await es.security.createApiKey({ name, role_descriptors: {} });
            apiKeysCreated.push(key.id);
            return key;
          },
        },
      },
    };
    taskManager = createHostTaskScheduling({
      repository: host.savedObjects.createInternalRepository(['task']),
      esClient: host.elasticsearch.asInternalUser,
      logger: core.logger,
      allowedTypes: /^workflow:/,
      credentials: {
        savedObjects: host.savedObjects,
        security: security as never,
        apiKeyType: 'es' as never,
        grantUiamApiKeys: false,
        canEncrypt: host.encryptedSavedObjects!.canEncrypt,
        encryptedSavedObjects: { getClient: host.encryptedSavedObjects!.getClient },
      },
    });

    const userKey = await es.security.createApiKey({ name: 'user', role_descriptors: {} });
    request = kibanaRequestFactory({
      headers: {
        authorization: `ApiKey ${Buffer.from(`${userKey.id}:${userKey.api_key}`).toString(
          'base64'
        )}`,
      },
    });
  });

  afterAll(async () => {
    await core?.stop();
    await esServer?.stop();
  });

  it('schedules a task with the credential of a request and reads it back decrypted', async () => {
    const scheduled = await taskManager.schedule(
      workflowTask('workflow:exec-1', { runAt: new Date(Date.now() + 86400000) }),
      { request, cloneApiKey: true } as never
    );
    expect(scheduled.id).toBe('workflow:exec-1');
    expect(apiKeysCreated).toHaveLength(1);

    // The key is encrypted at rest.
    const raw = await es.get<{ task: { apiKey: string } }>({
      index: TASK_INDEX,
      id: 'task:workflow:exec-1',
    });
    const stored = raw._source!.task.apiKey;
    expect(stored).toBeDefined();
    expect(Buffer.from(stored, 'base64').toString()).not.toContain(apiKeysCreated[0]);

    const task = await taskManager.get('workflow:exec-1');
    expect(task.apiKey).toBeDefined();
    expect(Buffer.from(task.apiKey!, 'base64').toString()).toContain(apiKeysCreated[0]);
    expect(task.userScope?.apiKeyId).toBe(apiKeysCreated[0]);
  });

  it('bulk gets, ok for a task and err for a missing one', async () => {
    const [found, missing] = await taskManager.bulkGet(['workflow:exec-1', 'workflow:nope']);
    expect(found).toEqual({
      tag: 'ok',
      value: expect.objectContaining({ id: 'workflow:exec-1', apiKey: expect.any(String) }),
    });
    expect(missing).toEqual({
      tag: 'err',
      error: expect.objectContaining({ id: 'workflow:nope', type: 'task' }),
    });
  });

  it('fetches tasks, only task documents, with their versions', async () => {
    await refresh();
    const { docs, versionMap } = await taskManager.fetch({
      query: { term: { 'task.taskType': 'workflow:run' } },
      seq_no_primary_term: true,
    });
    expect(docs.map(({ id }) => id)).toEqual(['workflow:exec-1']);
    expect(docs[0].apiKey).toBeDefined();
    expect(versionMap.get('workflow:exec-1')).toEqual(
      expect.objectContaining({ esId: 'task:workflow:exec-1' })
    );
  });

  it('ensures a task is scheduled, updating the interval when it exists', async () => {
    await taskManager.ensureScheduled(
      workflowTask('workflow:wake', { schedule: { interval: '1h' } })
    );
    await taskManager.ensureScheduled(
      workflowTask('workflow:wake', { schedule: { interval: '2h' } })
    );
    expect((await taskManager.get('workflow:wake')).schedule).toEqual({ interval: '2h' });
  });

  it('does not grant a key for an id that exists', async () => {
    const before = apiKeysCreated.length;
    await taskManager.ensureScheduled(workflowTask('workflow:exec-1'), {
      request,
      cloneApiKey: true,
    } as never);
    expect(apiKeysCreated).toHaveLength(before);
    // A new id does.
    await taskManager.ensureScheduled(
      workflowTask('workflow:exec-2', { runAt: new Date(Date.now() + 86400000) }),
      { request, cloneApiKey: true } as never
    );
    expect(apiKeysCreated).toHaveLength(before + 1);
  });

  it('runs a task soon', async () => {
    expect((await taskManager.get('workflow:exec-1')).runAt.getTime()).toBeGreaterThan(Date.now());

    expect(await taskManager.runSoon('workflow:exec-1')).toEqual({
      id: 'workflow:exec-1',
      forced: false,
    });
    const task = await taskManager.get('workflow:exec-1');
    expect(task.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(task.apiKey).toBeDefined();

    await expect(taskManager.runSoon('workflow:nope')).rejects.toEqual(
      expect.objectContaining({ output: expect.objectContaining({ statusCode: 404 }) })
    );
  });

  it('removes a task that does not exist only with removeIfExists', async () => {
    await expect(taskManager.removeIfExists('workflow:nope')).resolves.toBeUndefined();
    await expect(taskManager.remove('workflow:nope')).rejects.toEqual(
      expect.objectContaining({ output: expect.objectContaining({ statusCode: 404 }) })
    );
  });

  it('removes a task and queues its API key for invalidation', async () => {
    expect(await invalidationDocs()).toEqual([]);

    await taskManager.remove('workflow:exec-1');

    await expect(taskManager.get('workflow:exec-1')).rejects.toBeDefined();
    expect(await invalidationDocs()).toEqual([apiKeysCreated[0]]);
  });

  it('bulk removes tasks and queues their API keys for invalidation', async () => {
    await taskManager.bulkRemove(['workflow:exec-2', 'workflow:wake', 'workflow:nope']);

    const [exec2, wake] = await taskManager.bulkGet(['workflow:exec-2', 'workflow:wake']);
    expect(exec2.tag).toBe('err');
    expect(wake.tag).toBe('err');
    expect((await invalidationDocs()).sort()).toEqual([...apiKeysCreated].sort());
  });

  it('refuses to remove a task type it may not touch', async () => {
    await core.host.savedObjects.createInternalRepository(['task']).create(
      'task',
      {
        taskType: 'alerting:other',
        params: '{}',
        state: '{}',
        scheduledAt: new Date().toISOString(),
        runAt: new Date().toISOString(),
        status: 'idle',
        attempts: 0,
        enabled: true,
        traceparent: '',
      } as never,
      { id: 'alerting:other-1' }
    );
    await expect(taskManager.remove('alerting:other-1')).rejects.toThrow(/cannot be removed/);
    await expect(taskManager.runSoon('alerting:other-1')).rejects.toThrow(/cannot be run soon/);
    expect(await taskManager.get('alerting:other-1')).toEqual(
      expect.objectContaining({ id: 'alerting:other-1' })
    );
  });
});
