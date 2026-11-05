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
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
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
import { taskType } from '../task_types/workflow_scheduled.task';

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

const ES_WORKFLOW_ID = 'es-workflow';
const CUSTOM_STEP_WORKFLOW_ID = 'custom-step-workflow';

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

  const engineConfig = engineConfigDescriptor.schema.validate({});

  const settings = () => ({
    actions: actionsConfigSchema.validate({ allowedHosts: ['*'], enableFooterInEmail: false }),
    taskManager: { api_key_type: 'es', grant_uiam_api_keys: false },
    workflowsExecutionEngine: engineConfig,
    workflowsExecutionEngineCloud: {},
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
    server: { uuid: KIBANA_UUID, buildNum: 1, isServerless: false },
    encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
    settings: Object.fromEntries(
      Object.entries(settings()).map(([id, config]) => [id, serializeSettings(config)])
    ) as never,
  });

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
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: 120000,
      setCustomTaskRunEventFields: jest.fn(),
      fallback,
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();

  const workflowDocument = (name: string, steps: unknown[]) => {
    const now = new Date().toISOString();
    const definition = {
      name,
      enabled: true,
      version: '1',
      triggers: [{ type: 'scheduled', with: { every: '1d' } }],
      steps,
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
      spaceId: 'default',
      valid: true,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
  };

  const executionsOf = async (workflowId: string) => {
    await es.indices.refresh({ index: WORKFLOWS_EXECUTIONS_INDEX });
    const { hits } = await es.search<Record<string, any>>({
      index: WORKFLOWS_EXECUTIONS_INDEX,
      query: { term: { workflowId } },
    });
    return hits.hits.map((hit) => hit._source!);
  };

  beforeAll(async () => {
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
    for (const type of taskType.savedObjectTypes ?? []) {
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
          yaml: { type: 'text', index: false },
          definition: { type: 'object', enabled: false },
        },
      },
    });
    await es.index({
      index: WORKFLOW_INDEX_NAME,
      id: ES_WORKFLOW_ID,
      refresh: 'wait_for',
      document: workflowDocument('es workflow', [
        {
          name: 'health',
          type: 'elasticsearch.request',
          with: { method: 'GET', path: '/_cluster/health' },
        },
      ]),
    });
    await es.index({
      index: WORKFLOW_INDEX_NAME,
      id: CUSTOM_STEP_WORKFLOW_ID,
      refresh: 'wait_for',
      document: workflowDocument('custom step workflow', [
        { name: 'custom', type: 'unregistered.customStep', with: { value: 1 } },
      ]),
    });

    ({ encoded: apiKey } = await es.security.createApiKey({ name: 'workflow-key' }));

    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ name }: { name: string }) => name === 'workflowsExecutionEngine__workflow_scheduled'
    );
    const [built] = await Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: { [built.name]: { file: `${built.name}.js`, taskType: TASK_TYPE } },
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
  });

  it('runs a scheduled workflow with an elasticsearch step to completion, in the process', async () => {
    const fallback = jest.fn();
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
  });

  it('declines a workflow that uses a step the process does not have, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => undefined }));
    await run(CUSTOM_STEP_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await executionsOf(CUSTOM_STEP_WORKFLOW_ID)).toHaveLength(0);
  });
});
