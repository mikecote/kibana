/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

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
import { DataStreamClient } from '@kbn/data-streams';
import eventLogMappings from '@kbn/event-log-plugin/generated/mappings.json';
import { License } from '@kbn/licensing-plugin/common/license';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import {
  createConfig as createSecurityConfig,
  ConfigSchema as securityConfigSchema,
} from '@kbn/security-plugin/server/config';
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { config as engineConfigDescriptor } from '../config';
import { getWorkflowDataStreamDefinitions } from '../data_streams';
import {
  createOrUpdateIndex,
  WORKFLOWS_EXECUTIONS_INDEX,
  WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
  WORKFLOWS_STEP_EXECUTIONS_INDEX,
  WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
} from '../repositories/data_access_layer';
import { taskType as scheduledTaskType } from '../task_types/workflow_scheduled.task';
import {
  getWorkflowGlobalTimeoutResumeTaskId,
  getWorkflowImmediateResumeTaskId,
} from '../workflow_task_manager/workflow_task_manager';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

const KIBANA_VERSION = kibanaPackageJson.version;
const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
const ENCRYPTION_KEY = 'a'.repeat(32);
const TASK_TYPE = 'workflow:scheduled';
const LOGS_DATA_STREAM = '.workflows-execution-data-stream-logs';

const RUN_TASK_TYPE = 'workflow:run';
const RESUME_TASK_TYPE = 'workflow:resume';
const CONNECTOR_ID = 'webhook-1';
const ES_WORKFLOW_ID = 'es-workflow';
const CUSTOM_STEP_WORKFLOW_ID = 'custom-step-workflow';
const RUN_AS_WORKFLOW_ID = 'run-as-workflow';
const KIBANA_WORKFLOW_ID = 'kibana-workflow';
const CONNECTOR_WORKFLOW_ID = 'connector-workflow';
const FAILING_WORKFLOW_ID = 'failing-workflow';
const WAIT_WORKFLOW_ID = 'wait-workflow';
const CHILD_WORKFLOW_ID = 'child-workflow';
const PARENT_WORKFLOW_ID = 'parent-workflow';
const HANG_WORKFLOW_ID = 'hang-workflow';

/**
 * Runs `workflow:scheduled` from its own bundle, forked by the supervisor the way Kibana does,
 * against a real Elasticsearch: the engine's runtime is built from the task host, executes the
 * workflow, and writes its executions and logs; a workflow it cannot serve is declined.
 */
describe('the workflow:scheduled task type served from a bundle', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let apiKey: string;
  let seeder: Awaited<ReturnType<typeof startTaskProcessCore>>;
  let kibanaStub: Server;
  let kibanaUrl: string;
  let webhookStub: Server;
  let webhookUrl: string;
  let usageApiStub: Server;
  let usageApiUrl: string;
  const usageApiRecords: Array<Record<string, any>> = [];
  const kibanaRequests: Array<{ url?: string; method?: string; headers: IncomingHttpHeaders }> = [];
  const webhookRequests: string[] = [];

  const engineConfig = engineConfigDescriptor.schema.validate({});

  // The bodies of what the process answered: a run's answer carries no telemetry.
  const responseBodies: Array<Record<string, unknown>> = [];
  const capturingFetch = (async (input: unknown, init: unknown) => {
    const response = await undiciFetch(input as never, init as never);
    try {
      responseBodies.push((await response.clone().json()) as Record<string, unknown>);
    } catch {
      // not JSON
    }
    return response;
  }) as unknown as typeof fetch;

  const settings = () => ({
    actions: actionsConfigSchema.validate({ allowedHosts: ['*'], enableFooterInEmail: false }),
    taskManager: { api_key_type: 'es', grant_uiam_api_keys: false },
    workflowsExecutionEngine: engineConfig,
    workflowsExecutionEngineCloud: { serverless: { projectId: 'project-1' } },
    // The process meters itself, against this stand-in for the usage API.
    workflowsUsageApi: { url: usageApiUrl },
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

  interface RunOptions {
    attempts?: number;
    spaceId?: string;
    featureFlags?: Record<string, boolean>;
    fallback?: () => never;
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  const runTask = (
    type: string,
    taskInstance: { id: string; params: Record<string, unknown> } & Record<string, unknown>,
    options: RunOptions = {}
  ) =>
    new RemoteTaskRunner({
      route: supervisor.getRoute(type)!,
      request: {
        taskType: type,
        taskInstance: {
          taskType: type,
          state: {},
          attempts: options.attempts ?? 1,
          status: 'running',
          scheduledAt: new Date().toISOString(),
          runAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          retryAt: null,
          ownerId: null,
          ...taskInstance,
        },
        executionUuid: `${taskInstance.id}-${Date.now()}`,
        apiKey,
        spaceId: options.spaceId ?? 'default',
        userName: 'elastic',
        featureFlags: options.featureFlags,
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: options.timeoutMs ?? 120000,
      signal: options.signal,
      setCustomTaskRunEventFields: jest.fn(),
      fallback: options.fallback,
      fetchFn: capturingFetch,
    }).run();

  const run = (workflowId: string, fallback?: () => never, options: RunOptions = {}) =>
    runTask(
      TASK_TYPE,
      {
        id: `workflow:${workflowId}:scheduled`,
        params: { workflowId, spaceId: options.spaceId ?? 'default', triggerType: 'scheduled' },
      },
      { ...options, fallback }
    );

  const workflowDocument = (
    name: string,
    steps: unknown[],
    {
      spaceId = 'default',
      settings: workflowSettings,
    }: { spaceId?: string; settings?: unknown } = {}
  ) => {
    const now = new Date().toISOString();
    const definition = {
      name,
      enabled: true,
      version: '1',
      triggers: [{ type: 'scheduled', with: { every: '1d' } }],
      steps,
      ...(workflowSettings ? { settings: workflowSettings } : {}),
    };
    return {
      name,
      enabled: true,
      tags: [],
      triggerTypes: ['scheduled'],
      yaml: `name: ${name}`,
      definition,
      createdBy: 'elastic',
      lastUpdatedBy: 'elastic',
      spaceId,
      valid: true,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
  };

  const seedWorkflow = (id: string, ...args: Parameters<typeof workflowDocument>) =>
    es.index({
      index: WORKFLOW_INDEX_NAME,
      id,
      refresh: 'wait_for',
      document: workflowDocument(...args),
    });

  const executionsOf = async (workflowId: string) => {
    await es.indices.refresh({ index: WORKFLOWS_EXECUTIONS_INDEX });
    const { hits } = await es.search<Record<string, any>>({
      index: WORKFLOWS_EXECUTIONS_INDEX,
      query: { term: { workflowId } },
    });
    return hits.hits.map((hit) => hit._source!);
  };

  beforeAll(async () => {
    // The Kibana that dispatched the runs, as far as the self client can tell.
    kibanaStub = createServer((req, res) => {
      kibanaRequests.push({ url: req.url, method: req.method, headers: req.headers });
      if (req.url?.includes('/hang')) return; // never answers: a step that runs until cancelled
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'kibana', path: req.url }));
    });
    await new Promise<void>((resolve) => kibanaStub.listen(0, '127.0.0.1', resolve));
    kibanaUrl = `http://127.0.0.1:${(kibanaStub.address() as AddressInfo).port}`;
    // What a webhook connector calls.
    usageApiStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        usageApiRecords.push(...JSON.parse(Buffer.concat(chunks).toString() || '[]'));
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => usageApiStub.listen(0, '127.0.0.1', resolve));
    usageApiUrl = `http://127.0.0.1:${(usageApiStub.address() as AddressInfo).port}/api/v1/usage`;

    webhookStub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        webhookRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) => webhookStub.listen(0, '127.0.0.1', resolve));
    webhookUrl = `http://127.0.0.1:${(webhookStub.address() as AddressInfo).port}/hook`;

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
    for (const dataStream of Object.values(
      getWorkflowDataStreamDefinitions(engineConfig.storage)
    )) {
      await DataStreamClient.initializeTemplate({ dataStream, elasticsearchClient: es, logger });
    }
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
    await seedWorkflow(ES_WORKFLOW_ID, 'es workflow', [
      {
        name: 'health',
        type: 'elasticsearch.request',
        with: { method: 'GET', path: '/_cluster/health' },
      },
    ]);
    await seedWorkflow(
      RUN_AS_WORKFLOW_ID,
      'run as workflow',
      [
        {
          name: 'health',
          type: 'elasticsearch.request',
          with: { method: 'GET', path: '/_cluster/health' },
        },
      ],
      { settings: { run_as: 'service-account' } }
    );
    await seedWorkflow(CUSTOM_STEP_WORKFLOW_ID, 'custom step workflow', [
      { name: 'custom', type: 'unregistered.customStep', with: { value: 1 } },
    ]);
    await seedWorkflow(
      KIBANA_WORKFLOW_ID,
      'kibana workflow',
      [
        {
          name: 'status',
          type: 'kibana.request',
          with: { request: { method: 'GET', path: '/api/stub/thing' } },
        },
      ],
      { spaceId: 'other' }
    );
    await seedWorkflow(CONNECTOR_WORKFLOW_ID, 'connector workflow', [
      {
        name: 'notify',
        type: 'webhook',
        'connector-id': CONNECTOR_ID,
        with: { body: '{"hello":"workflows"}' },
      },
    ]);
    await seedWorkflow(FAILING_WORKFLOW_ID, 'failing workflow', [
      {
        name: 'broken',
        type: 'elasticsearch.request',
        with: { method: 'GET', path: '/index-that-does-not-exist/_search' },
      },
    ]);
    await seedWorkflow(WAIT_WORKFLOW_ID, 'wait workflow', [
      { name: 'sleep', type: 'wait', with: { duration: '8s' } },
      {
        name: 'after',
        type: 'elasticsearch.request',
        with: { method: 'GET', path: '/_cluster/health' },
      },
    ]);
    await seedWorkflow(CHILD_WORKFLOW_ID, 'child workflow', [
      {
        name: 'childStep',
        type: 'elasticsearch.request',
        with: { method: 'GET', path: '/_cluster/health' },
      },
    ]);
    await seedWorkflow(PARENT_WORKFLOW_ID, 'parent workflow', [
      { name: 'callChild', type: 'workflow.execute', with: { 'workflow-id': CHILD_WORKFLOW_ID } },
    ]);
    await seedWorkflow(HANG_WORKFLOW_ID, 'hanging workflow', [
      {
        name: 'hang',
        type: 'kibana.request',
        with: { request: { method: 'GET', path: '/api/hang' } },
      },
    ]);

    ({ encoded: apiKey } = await es.security.createApiKey({ name: 'workflow-key' }));

    // A process of the module, to seed what Kibana would have saved: the webhook connector.
    seeder = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: esConfig(),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        ...initFor(),
      },
      module: scheduledTaskType,
    });
    await seeder.host.savedObjects
      .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
      .create(
        'action',
        {
          name: 'webhook',
          actionTypeId: '.webhook',
          isMissingSecrets: false,
          config: { url: webhookUrl, method: 'post', hasAuth: false },
          secrets: { user: null, password: null },
        },
        { id: CONNECTOR_ID }
      );

    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const bundleNames = {
      [TASK_TYPE]: 'workflowsExecutionEngine__workflow_scheduled',
      [RUN_TASK_TYPE]: 'workflowsExecutionEngine__workflow_run',
      [RESUME_TASK_TYPE]: 'workflowsExecutionEngine__workflow_resume',
    };
    const entries = getTaskBundleEntries().filter(({ name }: { name: string }) =>
      Object.values(bundleNames).includes(name)
    );
    const built: Array<{ name: string }> = await Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: Object.fromEntries(
          Object.entries(bundleNames).map(([taskType_, name]) => {
            const { name: builtName } = built.find((bundle) => bundle.name === name)!;
            return [builtName, { file: `${builtName}.js`, taskType: taskType_ }];
          })
        ),
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
    await seeder?.stop();
    await esServer?.stop();
    await new Promise((resolve) => kibanaStub?.close(resolve));
    await new Promise((resolve) => webhookStub?.close(resolve));
    await new Promise((resolve) => usageApiStub?.close(resolve));
  });

  it('runs a scheduled workflow with an elasticsearch step to completion, in the process', async () => {
    const fallback = jest.fn();
    usageApiRecords.length = 0;
    responseBodies.length = 0;
    await run(ES_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const executions = await executionsOf(ES_WORKFLOW_ID);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toEqual(
      expect.objectContaining({
        workflowId: ES_WORKFLOW_ID,
        status: 'completed',
        spaceId: 'default',
      })
    );

    await es.indices.refresh({ index: WORKFLOWS_STEP_EXECUTIONS_INDEX });
    const steps = await es.search<Record<string, any>>({
      index: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      query: { term: { workflowRunId: executions[0].id } },
    });
    expect(steps.hits.hits).toHaveLength(1);
    const step = steps.hits.hits[0]._source!;
    expect(step).toEqual(expect.objectContaining({ stepId: 'health', status: 'completed' }));
    expect(step.output).toEqual(expect.objectContaining({ status: expect.any(String) }));

    // The logs data stream is a system data stream: Kibana reads it with its product origin.
    const kibanaEs = es.child({ headers: { 'x-elastic-product-origin': 'kibana' } });
    await kibanaEs.indices.refresh({ index: LOGS_DATA_STREAM });
    const logs = await kibanaEs.search({
      index: LOGS_DATA_STREAM,
      query: { term: { 'workflow.execution_id': executions[0].id } },
    });
    expect(logs.hits.hits.length).toBeGreaterThan(0);

    // Metering: the process sent the record to the usage API itself, before it answered...
    expect(usageApiRecords).toHaveLength(1);
    expect(usageApiRecords[0]).toEqual(
      expect.objectContaining({
        id: `workflow-execution-${executions[0].id}`,
        source: expect.objectContaining({
          instance_group_id: 'project-1',
          instance_group_type: 'serverless_project',
        }),
        usage: expect.objectContaining({
          type: 'workflows_execution',
          metadata: expect.objectContaining({ workflow_id: ES_WORKFLOW_ID, status: 'completed' }),
        }),
      })
    );
    // ...and its answer carries nothing for Kibana to apply but the result.
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const body of responseBodies) {
      expect(Object.keys(body)).not.toContain('telemetry');
    }
  });

  it('declines a workflow that uses a step the process does not have, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => undefined }));
    await run(CUSTOM_STEP_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await executionsOf(CUSTOM_STEP_WORKFLOW_ID)).toHaveLength(0);
  });

  it('declines a run_as workflow before any side effect, even with service accounts enabled', async () => {
    expect(settings().security.serviceAccounts.enabled).toBe(true);
    const fallback = jest.fn(() => ({ run: async () => undefined }));
    usageApiRecords.length = 0;
    await run(RUN_AS_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await executionsOf(RUN_AS_WORKFLOW_ID)).toHaveLength(0);
    expect(usageApiRecords).toHaveLength(0);
  });

  const stepsOf = async (executionId: string) => {
    await es.indices.refresh({ index: WORKFLOWS_STEP_EXECUTIONS_INDEX });
    const { hits } = await es.search<Record<string, any>>({
      index: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      query: { term: { workflowRunId: executionId } },
    });
    return hits.hits.map((hit) => hit._source!);
  };

  const tasksOf = async (type: string) => {
    await es.indices.refresh({ index: '.kibana_task_manager' });
    const { hits } = await es.search<{ task: Record<string, any> }>({
      index: '.kibana_task_manager',
      query: { term: { 'task.taskType': type } },
      size: 50,
    });
    return hits.hits.map((hit) => ({
      ...hit._source!.task,
      id: hit._id!.replace(/^task:/, ''),
    })) as Array<Record<string, any> & { id: string }>;
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('kibana steps', () => {
    it('calls Kibana through the self client with the credential of the run, at the path of the step', async () => {
      kibanaRequests.length = 0;
      const fallback = jest.fn();
      await run(KIBANA_WORKFLOW_ID, fallback as never, {
        spaceId: 'other',
        featureFlags: { [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: true },
      });

      expect(fallback).not.toHaveBeenCalled();
      const [execution] = await executionsOf(KIBANA_WORKFLOW_ID);
      expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'other' }));
      expect(kibanaRequests).toHaveLength(1);
      expect(kibanaRequests[0].url).toBe('/api/stub/thing');
      expect(kibanaRequests[0].headers.authorization).toBe(`ApiKey ${apiKey}`);
      expect(kibanaRequests[0].headers['x-elastic-internal-origin']).toBe('Kibana');
      const [step] = await stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'status', status: 'completed' }));
      expect(JSON.stringify(step.output)).toContain('/api/stub/thing');
    });

    it('calls Kibana through the legacy transport at the address Kibana sent', async () => {
      kibanaRequests.length = 0;
      await es.deleteByQuery({
        index: WORKFLOWS_EXECUTIONS_INDEX,
        refresh: true,
        query: { term: { workflowId: KIBANA_WORKFLOW_ID } },
      });
      await run(KIBANA_WORKFLOW_ID, undefined, {
        spaceId: 'other',
        featureFlags: { [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: false },
      });

      const [execution] = await executionsOf(KIBANA_WORKFLOW_ID);
      expect(execution.status).toBe('completed');
      expect(kibanaRequests.length).toBeGreaterThan(0);
      expect(kibanaRequests[0].url).toContain('/api/stub/thing');
    });
  });

  describe('connector steps', () => {
    it('executes a webhook connector with the actions of the process and logs the execution', async () => {
      const fallback = jest.fn();
      await run(CONNECTOR_WORKFLOW_ID, fallback as never);

      expect(fallback).not.toHaveBeenCalled();
      const [execution] = await executionsOf(CONNECTOR_WORKFLOW_ID);
      expect(execution.status).toBe('completed');
      expect(webhookRequests).toEqual(['{"hello":"workflows"}']);
      const [step] = await stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'notify', status: 'completed' }));
      expect(step.output).toBeDefined();

      const kibanaEs = es.child({ headers: { 'x-elastic-product-origin': 'kibana' } });
      let events: unknown[] = [];
      for (let attempt = 0; attempt < 20 && events.length === 0; attempt++) {
        await kibanaEs.indices.refresh({ index: '.kibana-event-log-*' });
        events = (
          await kibanaEs.search({
            index: '.kibana-event-log-*',
            query: {
              bool: {
                filter: [
                  { term: { 'event.provider': 'actions' } },
                  { term: { 'event.action': 'execute' } },
                ],
              },
            },
          })
        ).hits.hits;
        if (events.length === 0) await sleep(500);
      }
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('failures and cancellation', () => {
    it('ends a failing workflow FAILED and the task normally, as in Kibana, and emits the failure event', async () => {
      const result = await run(FAILING_WORKFLOW_ID);

      // A failed workflow is a finished run, not a failed task (see `runWorkflow`): it returns nothing,
      // as the task of the plugin does in Kibana.
      expect(result).toBeUndefined();
      const [execution] = await executionsOf(FAILING_WORKFLOW_ID);
      expect(execution.status).toBe('failed');
      const [step] = await stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'broken', status: 'failed' }));

      const kibanaEs = es.child({ headers: { 'x-elastic-product-origin': 'kibana' } });
      await kibanaEs.indices.refresh({ index: '.workflows-events*' });
      const events = await kibanaEs.search({
        index: '.workflows-events*',
        query: { term: { sourceExecutionId: execution.id } },
      });
      expect(events.hits.hits.length).toBeGreaterThan(0);
    });

    it('cancels a run that is waiting on a step when Task Manager cancels it', async () => {
      const controller = new AbortController();
      const running = run(HANG_WORKFLOW_ID, undefined, {
        featureFlags: { [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: true },
        signal: controller.signal,
      });
      for (let i = 0; i < 40 && !kibanaRequests.some(({ url }) => url?.includes('/hang')); i++) {
        await sleep(250);
      }
      controller.abort();
      await running.catch(() => undefined);

      let execution: Record<string, any> | undefined;
      for (let i = 0; i < 20; i++) {
        [execution] = await executionsOf(HANG_WORKFLOW_ID);
        if (execution && ['cancelled', 'failed'].includes(execution.status)) break;
        await sleep(500);
      }
      expect(execution?.status).toBe('cancelled');
    });
  });

  describe('waiting and resuming across processes', () => {
    it('parks a long wait as a workflow:resume task and finishes it in a second process', async () => {
      await run(WAIT_WORKFLOW_ID);

      const [execution] = await executionsOf(WAIT_WORKFLOW_ID);
      expect(execution.status).toBe('waiting');
      const tasks = await tasksOf(RESUME_TASK_TYPE);
      const forRun = tasks.filter(
        ({ params }) => JSON.parse(params).workflowRunId === execution.id
      );
      expect(forRun.length).toBeGreaterThan(0);
      // The tasks carry the credential of the run, granted by the process.
      for (const task of forRun) {
        expect(task.apiKey).toEqual(expect.any(String));
        expect(task.runAt).toEqual(expect.any(String));
      }

      // Past the wait, Kibana would claim the resume task and dispatch it.
      await sleep(9000);
      await runTask(RESUME_TASK_TYPE, {
        id: getWorkflowImmediateResumeTaskId(execution.id),
        params: { workflowRunId: execution.id, spaceId: 'default' },
      });

      const [resumed] = await executionsOf(WAIT_WORKFLOW_ID);
      expect(resumed.status).toBe('completed');
      const steps = await stepsOf(execution.id);
      expect(steps.map((step) => step.stepId).sort()).toEqual(['after', 'sleep']);
      expect(getWorkflowGlobalTimeoutResumeTaskId(execution.id)).toEqual(expect.any(String));
    });
  });

  describe('child workflows', () => {
    it('runs a sync child as a workflow:run task and resumes the parent when it finishes', async () => {
      await run(PARENT_WORKFLOW_ID);

      const [parent] = await executionsOf(PARENT_WORKFLOW_ID);
      const [child] = await executionsOf(CHILD_WORKFLOW_ID);
      expect(child).toBeDefined();
      expect(parent.status).toBe('waiting_for_child');
      const runTasks = await tasksOf(RUN_TASK_TYPE);
      const childTask = runTasks.find(
        ({ params }) => JSON.parse(params).workflowRunId === child.id
      );
      expect(childTask).toBeDefined();
      expect(childTask!.apiKey).toEqual(expect.any(String));

      await runTask(RUN_TASK_TYPE, {
        id: childTask!.id,
        params: { workflowRunId: child.id, spaceId: 'default' },
      });
      expect((await executionsOf(CHILD_WORKFLOW_ID))[0].status).toBe('completed');

      // Finishing the child schedules the resume of the parent.
      const resumeTasks = await tasksOf(RESUME_TASK_TYPE);
      const parentTask = resumeTasks.find(
        ({ params }) => JSON.parse(params).workflowRunId === parent.id
      );
      expect(parentTask).toBeDefined();
      await runTask(RESUME_TASK_TYPE, {
        id: getWorkflowImmediateResumeTaskId(parent.id),
        params: { workflowRunId: parent.id, spaceId: 'default' },
      });
      expect((await executionsOf(PARENT_WORKFLOW_ID))[0].status).toBe('completed');
    });
  });
});
