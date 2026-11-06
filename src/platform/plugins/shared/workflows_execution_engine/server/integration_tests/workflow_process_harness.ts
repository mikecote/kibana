/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-explicit-any, @kbn/eslint/require_kbn_fs */

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
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { config as engineConfigDescriptor } from '../config';
import { installWorkflowDataStreamTemplates } from '../data_streams';
import {
  createOrUpdateIndex,
  WORKFLOWS_EXECUTIONS_INDEX,
  WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
  WORKFLOWS_STEP_EXECUTIONS_INDEX,
  WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
} from '../repositories/data_access_layer';
import { taskType as scheduledTaskType } from '../task_types/workflow_scheduled.task';

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

export interface StubRequest {
  url?: string;
  method?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface WorkflowProcessHarnessOptions {
  /** The workflows to seed (a `scheduled` trigger is added unless `triggers` is given), by id. */
  workflows: Record<string, { name?: string; steps: unknown[]; triggers?: unknown[] }>;
  /** Answers the calls of the process to Kibana (its self client); 200 with `{}` by default. */
  kibanaHandler?: (request: StubRequest) => { status?: number; body: unknown };
  /** The configs the steps read, by plugin id, added to the ones of the engine. */
  settings?: Record<string, unknown>;
  /** Saved object types the plugin of the steps registers, whose indices Kibana would have. */
  savedObjectTypes?: Array<{ name: string; mappings: unknown; indexPattern?: string }>;
  /**
   * Seeds what Kibana would have, with the host of a process of the module (saved objects, whose
   * client encrypts the attributes of the encrypted types, such as the `secrets` of a connector) and the ES client.
   */
  seed?: (context: { es: Client; host: TaskHost; kibanaUrl: string }) => Promise<void>;
}

/**
 * Real Elasticsearch, a stub of Kibana and the real `workflow:scheduled` bundle in a real task
 * process, with what Kibana would have installed (saved object and execution indices, data stream
 * templates, the event log) and some workflows seeded. A test asserts what a run did.
 */
const startHarness = async (
  options: WorkflowProcessHarnessOptions,
  cleanups: Array<() => Promise<unknown>>
) => {
  const engineConfig = engineConfigDescriptor.schema.validate({});
  const kibanaRequests: StubRequest[] = [];
  let apiKey = '';

  const kibanaStub: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = { url: req.url, method: req.method, headers: req.headers, body };
      kibanaRequests.push(request);
      const answer = options.kibanaHandler?.(request) ?? { body: {} };
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => kibanaStub.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => kibanaStub.close(resolve)));
  const kibanaUrl = `http://127.0.0.1:${(kibanaStub.address() as AddressInfo).port}`;

  const settings = () => ({
    actions: actionsConfigSchema.validate({ allowedHosts: ['*'], enableFooterInEmail: false }),
    taskManager: { api_key_type: 'es', grant_uiam_api_keys: false },
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
    ...options.settings,
  });

  const initFor = () => ({
    server: { uuid: KIBANA_UUID, buildNum: 1, isServerless: false, publicBaseUrl: kibanaUrl },
    encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
    settings: Object.fromEntries(
      Object.entries(settings()).map(([id, config]) => [id, serializeSettings(config)])
    ) as never,
  });

  const { startES } = createTestServers({
    adjustTimeout: (t) => jest.setTimeout(t),
    settings: { es: { license: 'trial' } },
  });
  const esServer: TestElasticsearchUtils = await startES();
  cleanups.push(() => esServer.stop());
  const es: Client = esServer.es.getClient();
  const esConfig = () =>
    elasticsearchConfigFromEnv({
      ES_URL: esServer.hosts[0],
      ES_USERNAME: esServer.username,
      ES_PASSWORD: esServer.password,
    });

  // The saved object indices Kibana has: what the module declares, `config` and `task`.
  const indexMappings = new Map<string, Record<string, unknown>>();
  for (const type of [
    ...(scheduledTaskType.savedObjectTypes ?? []),
    ...(options.savedObjectTypes ?? []),
  ]) {
    const index = type.indexPattern ?? '.kibana';
    indexMappings.set(index, {
      ...(indexMappings.get(index) ?? {}),
      [type.name]: type.mappings,
    });
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
  await installWorkflowDataStreamTemplates({ esClient: es, logger, storage: engineConfig.storage });
  await es.indices.create({
    index: WORKFLOW_INDEX_NAME,
    mappings: {
      dynamic: false,
      properties: {
        spaceId: { type: 'keyword' },
        enabled: { type: 'boolean' },
        triggerTypes: { type: 'keyword' },
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
  for (const [id, { name = id, steps, triggers }] of Object.entries(options.workflows)) {
    const definedTriggers = triggers ?? [{ type: 'scheduled', with: { every: '1d' } }];
    await es.index({
      index: WORKFLOW_INDEX_NAME,
      id,
      refresh: 'wait_for',
      document: {
        name,
        enabled: true,
        tags: [],
        triggerTypes: definedTriggers.map((trigger) => (trigger as { type: string }).type),
        yaml: `name: ${name}`,
        definition: {
          name,
          enabled: true,
          version: '1',
          triggers: definedTriggers,
          steps,
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
  }

  ({ encoded: apiKey } = await es.security.createApiKey({ name: 'workflow-key' }));

  if (options.seed) {
    // A process of the module, to seed what Kibana would have saved, such as connectors.
    const seeder = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: esConfig(),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        ...initFor(),
      },
      module: scheduledTaskType,
    });
    try {
      await options.seed({
        es,
        host: seeder.host as TaskHost,
        kibanaUrl,
      });
    } finally {
      await seeder.stop();
    }
  }

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
      bundles: { [built[0].name]: { file: `${built[0].name}.js`, taskType: TASK_TYPE } },
    })
  );
  const supervisor = new TaskProcessSupervisor({
    settings: {
      bundle_dir: bundleDir,
      kibanaVersion: KIBANA_VERSION,
      getElasticsearchConfig: esConfig,
      getInitFor: initFor,
    },
    logger: loggingSystemMock.createLogger(),
  });
  supervisor.start();
  cleanups.push(() => supervisor.stop());

  /** Runs the scheduled task of a workflow in the process; `fallback` is what Kibana runs when it is declined. */
  const run = (workflowId: string, fallback?: () => never) =>
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
      fallback,
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();

  type Document = Record<string, any>;
  const executionsOf = async (workflowId: string): Promise<Document[]> => {
    await es.indices.refresh({ index: WORKFLOWS_EXECUTIONS_INDEX });
    const { hits } = await es.search<Document>({
      index: WORKFLOWS_EXECUTIONS_INDEX,
      query: { term: { workflowId } },
    });
    return hits.hits.map((hit) => hit._source!);
  };
  const stepsOf = async (executionId: string): Promise<Document[]> => {
    await es.indices.refresh({ index: WORKFLOWS_STEP_EXECUTIONS_INDEX });
    const { hits } = await es.search<Document>({
      index: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      query: { term: { workflowRunId: executionId } },
    });
    return hits.hits.map((hit) => hit._source!);
  };

  return {
    es,
    apiKey,
    kibanaUrl,
    kibanaRequests,
    run,
    executionsOf,
    stepsOf,
    stop: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
};

/** The harness; whatever it started is stopped when its setup fails, so a failed setup leaves nothing running. */
export const startWorkflowProcessHarness = async (options: WorkflowProcessHarnessOptions) => {
  const cleanups: Array<() => Promise<unknown>> = [];
  try {
    return await startHarness(options, cleanups);
  } catch (error) {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    throw error;
  }
};
