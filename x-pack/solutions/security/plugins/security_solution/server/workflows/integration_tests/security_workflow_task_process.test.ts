/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Client } from '@elastic/elasticsearch';
import { mkdtempSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { IncomingHttpHeaders, Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { configSchema as actionsConfigSchema } from '@kbn/actions-plugin/server/config';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import eventLogMappings from '@kbn/event-log-plugin/generated/mappings.json';
import { License } from '@kbn/licensing-plugin/common/license';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import {
  createConfig as createSecurityConfig,
  ConfigSchema as securityConfigSchema,
} from '@kbn/security-plugin/server/config';
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { TaskSchedulingDefinitions } from '@kbn/task-manager-plugin/server/task_scheduling_definition_registry';
import { createTaskSchedulingSnapshot } from '@kbn/task-manager-plugin/server/task_scheduling_snapshot';
import { WORKFLOW_TASK_SCHEDULING_DEFINITIONS } from '@kbn/workflows-execution-engine/server/workflow_task_manager/task_scheduling_definitions';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { config as engineConfigDescriptor } from '@kbn/workflows-execution-engine/server/config';
import { installWorkflowDataStreamTemplates } from '@kbn/workflows-execution-engine/server/data_streams';
import {
  createOrUpdateIndex,
  WORKFLOWS_EXECUTIONS_INDEX,
  WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
  WORKFLOWS_STEP_EXECUTIONS_INDEX,
  WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
} from '@kbn/workflows-execution-engine/server/repositories/data_access_layer';
import { taskType as scheduledTaskType } from '@kbn/workflows-execution-engine/server/task_types/workflow_scheduled.task';
import { NOTE_URL } from '../../../common/constants';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

const KIBANA_VERSION = kibanaPackageJson.version;
const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
const ENCRYPTION_KEY = 'a'.repeat(32);
const TASK_TYPE = 'workflow:scheduled';
const BUNDLE_NAME = 'workflowsExecutionEngine__workflow_scheduled';
const NOTE_WORKFLOW_ID = 'security-note-workflow';

/**
 * Runs a `workflow:scheduled` workflow with a security step (`security.createNote`, which calls the
 * Kibana API through the context of the engine) from the real bundle in a real task process: the
 * step comes from the `workflow-steps` contribution of security_solution, and the run is served by
 * the process, not declined.
 */
describe('security_solution workflow steps served from the workflow:scheduled bundle', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let apiKey: string;
  let kibanaStub: Server;
  let kibanaUrl: string;
  const kibanaRequests: Array<{
    url?: string;
    method?: string;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];

  const engineConfig = engineConfigDescriptor.schema.validate({});

  const taskSchedulingDefinitions = new TaskSchedulingDefinitions();
  taskSchedulingDefinitions.registerTaskDefinitions(WORKFLOW_TASK_SCHEDULING_DEFINITIONS);
  const settings = () => ({
    actions: actionsConfigSchema.validate({ allowedHosts: ['*'], enableFooterInEmail: false }),
    taskManager: {
      api_key_type: 'es',
      grant_uiam_api_keys: false,
      scheduling: {
        taskManagerId: `kibana:${KIBANA_UUID}`,
        securityEnabled: true,
        middlewareIds: [],
        allowReadingInvalidState: false,
        definitions: createTaskSchedulingSnapshot(taskSchedulingDefinitions),
      },
    },
    workflowsExecutionEngine: engineConfig,
    workflowsExecutionEngineCloud: { serverless: { projectId: 'project-1' } },
    security: getSecurityTaskProcessSettings({
      license: new License({
        license: {
          uid: 'uid',
          type: 'trial',
          mode: 'trial',
          status: 'active',
          expiryDateInMillis: Date.now() + 86400000,
        },
        features: { security: { isAvailable: true, isEnabled: true } },
        signature: 'sig',
      }),
      config: createSecurityConfig(
        securityConfigSchema.validate({ audit: { enabled: false } }),
        loggingSystemMock.create().get(),
        { isTLSEnabled: false }
      ),
      applicationName: 'kibana-.kibana',
      kibanaServerResourceURL: 'http://localhost:5601',
    }),
  });

  const initFor = () => ({
    server: { uuid: KIBANA_UUID, buildNum: 1, isServerless: false, publicBaseUrl: kibanaUrl },
    encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
    settings: Object.fromEntries(
      Object.entries(settings()).map(([id, config]) => [id, serializeSettings(config)])
    ) as never,
  });

  const run = (workflowId: string, onDispatchFailure?: jest.Mock) =>
    new RemoteTaskRunner({
      route: supervisor.getRoute(TASK_TYPE)!,
      request: {
        taskType: TASK_TYPE,
        taskInstance: {
          id: `workflow:${workflowId}:scheduled`,
          taskType: TASK_TYPE,
          params: { workflowId, spaceId: 'default', triggerType: 'scheduled' },
          state: {},
          attempts: 1,
          status: 'running',
          scheduledAt: new Date().toISOString(),
          runAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          retryAt: null,
          ownerId: null,
        },
        executionUuid: `${workflowId}-${Date.now()}`,
        apiKey,
        spaceId: 'default',
        userName: 'elastic',
        featureFlags: { [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: true },
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: 120000,
      setCustomTaskRunEventFields: jest.fn(),
      onDispatchFailure,
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();

  beforeAll(async () => {
    // The Kibana that dispatched the run, as far as the self client can tell.
    kibanaStub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        kibanaRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ note: { noteId: 'note-from-stub' } }));
      });
    });
    await new Promise<void>((resolve) => kibanaStub.listen(0, '127.0.0.1', resolve));
    kibanaUrl = `http://127.0.0.1:${(kibanaStub.address() as AddressInfo).port}`;

    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();
    const esConfig = () =>
      elasticsearchConfigFromEnv({
        ES_URL: esServer.hosts[0],
        ES_USERNAME: esServer.username,
        ES_PASSWORD: esServer.password,
      });

    // The saved object indices Kibana has: what the module declares, `config` and `task`.
    const indexMappings = new Map<string, Record<string, unknown>>();
    for (const type of scheduledTaskType.savedObjectTypes ?? []) {
      const index = type.indexPattern ?? '.kibana';
      indexMappings.set(index, { ...(indexMappings.get(index) ?? {}), [type.name]: type.mappings });
    }
    indexMappings.set('.kibana', {
      ...(indexMappings.get('.kibana') ?? {}),
      config: { properties: { buildNum: { type: 'integer' } } },
    });
    indexMappings.set('.kibana_task_manager', {
      ...(indexMappings.get('.kibana_task_manager') ?? {}),
      task: {
        properties: {
          taskType: { type: 'keyword' },
          scope: { type: 'keyword' },
          enabled: { type: 'boolean' },
          status: { type: 'keyword' },
          runAt: { type: 'date' },
        },
      },
    });
    for (const [index, properties] of indexMappings) {
      await es.indices.create({
        index: `${index}_${KIBANA_VERSION}_001`,
        aliases: { [index]: {}, [`${index}_${KIBANA_VERSION}`]: {} },
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
            ...Object.fromEntries(
              Object.entries(properties).map(([name, mapping]) => [
                name,
                (mapping as { properties?: unknown })?.properties
                  ? { properties: (mapping as { properties: unknown }).properties }
                  : mapping,
              ])
            ),
          },
        } as never,
      });
    }
    await es.indices.putIndexTemplate({
      name: '.kibana-event-log-template',
      index_patterns: ['.kibana-event-log-*'],
      data_stream: { hidden: true },
      priority: 100,
      template: { mappings: eventLogMappings as never },
    });
    await es.indices.createDataStream({ name: '.kibana-event-log-ds' });

    // What Kibana installs for the engine: the execution indices, the data stream templates and the workflows index.
    const logger = loggingSystemMock.createLogger();
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
      logger,
    });
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
      logger,
    });
    await installWorkflowDataStreamTemplates({
      esClient: es,
      logger,
      storage: engineConfig.storage,
    });
    await es.indices.create({
      index: WORKFLOW_INDEX_NAME,
      mappings: {
        dynamic: false,
        properties: {
          spaceId: { type: 'keyword' },
          enabled: { type: 'boolean' },
          managed: { type: 'boolean' },
          deleted_at: { type: 'date' },
          updated_at: { type: 'date' },
          created_at: { type: 'date' },
          yaml: { type: 'text', index: false },
          definition: { type: 'object', enabled: false },
        },
      },
    });
    const now = new Date().toISOString();
    await es.index({
      index: WORKFLOW_INDEX_NAME,
      id: NOTE_WORKFLOW_ID,
      refresh: 'wait_for',
      document: {
        name: 'note workflow',
        enabled: true,
        tags: [],
        triggerTypes: ['scheduled'],
        yaml: 'name: note workflow',
        definition: {
          name: 'note workflow',
          enabled: true,
          version: '1',
          triggers: [{ type: 'scheduled', with: { every: '1d' } }],
          steps: [
            {
              name: 'note',
              type: 'security.createNote',
              with: { text: 'written by a workflow', document_id: 'alert-1' },
            },
          ],
        },
        createdBy: 'elastic',
        lastUpdatedBy: 'elastic',
        spaceId: 'default',
        valid: true,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    ({ encoded: apiKey } = await es.security.createApiKey({ name: 'workflow-key' }));

    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ name }: { name: string }) => name === BUNDLE_NAME
    );
    const built: Array<{ name: string }> = await Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: { [built[0].name]: { file: `${built[0].name}.mjs`, taskType: TASK_TYPE } },
      })
    );
    supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: bundleDir,
        kibanaVersion: KIBANA_VERSION,
        getElasticsearchConfig: esConfig,
        getInitFor: initFor,
      },
      logger: loggingSystemMock.createLogger(),
    });
    supervisor.start();
  });

  afterAll(async () => {
    await supervisor?.stop();
    await esServer?.stop();
    await new Promise((resolve) => kibanaStub?.close(resolve));
  });

  it('runs a security step that calls the Kibana API in the process, with the credential of the run', async () => {
    const onDispatchFailure = jest.fn();
    await run(NOTE_WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step type is in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    await es.indices.refresh({ index: WORKFLOWS_EXECUTIONS_INDEX });
    const { hits } = await es.search<Record<string, unknown> & { id: string; output?: unknown }>({
      index: WORKFLOWS_EXECUTIONS_INDEX,
      query: { term: { workflowId: NOTE_WORKFLOW_ID } },
    });
    expect(hits.hits).toHaveLength(1);
    const execution = hits.hits[0]._source!;
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));

    expect(kibanaRequests).toHaveLength(1);
    expect(kibanaRequests[0].method).toBe('PATCH');
    expect(kibanaRequests[0].url).toBe(NOTE_URL);
    expect(kibanaRequests[0].headers.authorization).toBe(`ApiKey ${apiKey}`);
    expect(kibanaRequests[0].headers['x-elastic-internal-origin']).toBe('Kibana');
    expect(JSON.parse(kibanaRequests[0].body)).toEqual({
      note: { note: 'written by a workflow', eventId: 'alert-1', timelineId: '' },
    });

    await es.indices.refresh({ index: WORKFLOWS_STEP_EXECUTIONS_INDEX });
    const steps = await es.search<Record<string, unknown> & { id: string; output?: unknown }>({
      index: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      query: { term: { workflowRunId: execution.id } },
    });
    expect(steps.hits.hits).toHaveLength(1);
    const step = steps.hits.hits[0]._source!;
    expect(step).toEqual(expect.objectContaining({ stepId: 'note', status: 'completed' }));
    expect(step.output).toEqual(
      expect.objectContaining({ success: true, note_id: 'note-from-stub' })
    );
  });
});
