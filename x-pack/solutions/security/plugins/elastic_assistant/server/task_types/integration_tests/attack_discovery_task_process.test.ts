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

import { mkdtempSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import type { Client } from '@elastic/elasticsearch';
import { REPO_ROOT, kibanaPackageJson } from '@kbn/repo-info';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { configSchema as actionsConfigSchema } from '@kbn/actions-plugin/server/config';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import eventLogMappings from '@kbn/event-log-plugin/generated/mappings.json';
import {
  ConfigSchema as securityConfigSchema,
  createConfig as createSecurityConfig,
} from '@kbn/security-plugin/server/config';
import { License } from '@kbn/licensing-plugin/common/license';
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { parseYamlToJSONWithoutValidation } from '@kbn/workflows-yaml';
import {
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
  getManagedWorkflowDefinition,
} from '@kbn/workflows/managed';
import {
  createOrUpdateIndex,
  WORKFLOWS_EXECUTIONS_INDEX,
  WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
  WORKFLOWS_STEP_EXECUTIONS_INDEX,
  WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
} from '@kbn/workflows-execution-engine/server/repositories/data_access_layer';
import { createStorage } from '@kbn/workflows-management-plugin/server/storage/workflow_storage';
import { computeManagedDefinitionHash } from '@kbn/workflows-management-plugin/server/services/managed_workflow_status';
import { getIndexTemplateAndPattern } from '../../lib/data_stream/helpers';
import { getResourceName } from '../../ai_assistant_service';
import { ANONYMIZATION_FIELDS_RESOURCE } from '../../ai_assistant_service/constants';
import { taskType } from '../attack_discovery.task';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

const KIBANA_VERSION = kibanaPackageJson.version;
const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
const ENCRYPTION_KEY = 'a'.repeat(32);
const TASK_TYPE = 'alerting:attack-discovery';
const ALERTS_INDEX = '.alerts-security.alerts-default';
const CONNECTOR_ID = 'openai-1';
const LEGACY_RULE_ID = 'legacy-rule';
const WORKFLOW_RULE_ID = 'workflow-rule';

/**
 * Runs the attack discovery rule type from its own bundle, forked by the supervisor the way Kibana
 * does, against a real Elasticsearch and a local server that plays the model of a `.gen-ai` connector.
 */
describe('the attack discovery rule type served from a bundle', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let seeder: Awaited<ReturnType<typeof startTaskProcessCore>>;
  let llm: Server;
  let llmUrl: string;
  const llmRequests: string[] = [];

  const settings = () => ({
    alerting: alertingConfigSchema.validate({}),
    alertingRun: {
      maintenanceWindowsEnabled: true,
      dataViews: { scriptedFieldsEnabled: true },
      search: { searchConfig: searchConfigSchema.validate({}), rollupsEnabled: false },
    },
    actions: actionsConfigSchema.validate({
      allowedHosts: ['*'],
      enableFooterInEmail: false,
    }),
    cases: { isCasesAttachmentsEnabled: true, isTemplatesEnabled: false },
    taskManager: { api_key_type: 'es', grant_uiam_api_keys: false },
    workflowsExecutionEngine: {
      storage: { source: 'plain_index', dataRetention: '90d' },
      eventDriven: { enabled: true, logEvents: true, maxChainDepth: 10 },
    },
    security: getSecurityTaskProcessSettings({
      // The license Kibana had when it started the run: with security available and enabled.
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

  const run = (ruleId: string, timeoutMs = 180000) =>
    new RemoteTaskRunner({
      route: supervisor.getRoute(TASK_TYPE)!,
      request: {
        taskType: TASK_TYPE,
        taskInstance: {
          id: ruleId,
          taskType: TASK_TYPE,
          params: { alertId: ruleId, spaceId: 'default', consumer: 'siem' },
          state: {},
          attempts: 0,
          status: 'running',
          scheduledAt: new Date().toISOString(),
          runAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          retryAt: null,
          ownerId: null,
        },
        executionUuid: `${ruleId}-${Date.now()}`,
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();

  const discoveryJson = JSON.stringify({
    insights: [
      {
        alertIds: ['alert-1'],
        detailsMarkdown: 'A host ran a suspicious command.',
        entitySummaryMarkdown: 'host {{ host.name host-1 }}',
        mitreAttackTactics: ['Execution'],
        summaryMarkdown: 'Suspicious activity on {{ host.name host-1 }}',
        title: 'Suspicious command',
      },
    ],
  });

  beforeAll(async () => {
    llm = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        llmRequests.push(body);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: discoveryJson },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    llmUrl = `http://127.0.0.1:${(llm.address() as { port: number }).port}/v1/chat/completions`;

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

    // The alerts Kibana would have written, and the anonymization fields of the default space.
    await es.indices.create({
      index: ALERTS_INDEX,
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          'kibana.alert.risk_score': { type: 'float' },
          'kibana.alert.workflow_status': { type: 'keyword' },
          'kibana.alert.rule.name': { type: 'keyword' },
          'host.name': { type: 'keyword' },
        },
      },
    });
    await es.index({
      index: ALERTS_INDEX,
      id: 'alert-1',
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date().toISOString(),
        'kibana.alert.workflow_status': 'open',
        'kibana.alert.rule.name': 'rule',
        'kibana.alert.risk_score': 21,
        'host.name': 'host-1',
      },
    });
    const anonymizationIndex = getIndexTemplateAndPattern(
      getResourceName(ANONYMIZATION_FIELDS_RESOURCE),
      'default'
    ).alias;
    await es.indices.create({
      index: anonymizationIndex,
      mappings: { properties: { updated_at: { type: 'date' }, field: { type: 'keyword' } } },
    });
    const now = new Date().toISOString();
    for (const [field, anonymized] of [
      ['_id', false],
      ['host.name', true],
      ['@timestamp', false],
    ] as const) {
      await es.index({
        index: anonymizationIndex,
        document: {
          '@timestamp': now,
          created_at: now,
          updated_at: now,
          field,
          allowed: true,
          anonymized,
          namespace: 'default',
        },
      });
    }
    await es.indices.refresh({ index: anonymizationIndex });

    seeder = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: esConfig(),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        ...initFor(),
      },
      module: taskType,
    });
    const client = seeder.host.savedObjects.getUnsafeInternalClient({
      includedHiddenTypes: ['alert', 'action', 'config'],
    });
    const { encoded } = await es.security.createApiKey({ name: 'rule-key' });
    await client.create(
      'action',
      {
        name: 'openai',
        actionTypeId: '.gen-ai',
        isMissingSecrets: false,
        config: { apiProvider: 'OpenAI', apiUrl: llmUrl, defaultModel: 'gpt-4o' },
        secrets: { apiKey: 'secret' },
      },
      { id: CONNECTOR_ID }
    );
    const rule = (params: Record<string, unknown>) => ({
      name: 'attack discovery',
      tags: [],
      alertTypeId: 'attack-discovery',
      consumer: 'siem',
      legacyId: null,
      schedule: { interval: '1d' },
      enabled: true,
      actions: [],
      params: {
        alertsIndexPattern: ALERTS_INDEX,
        apiConfig: {
          connectorId: CONNECTOR_ID,
          actionTypeId: '.gen-ai',
          name: 'openai',
          model: 'gpt-4o',
        },
        size: 10,
        start: 'now-1d',
        end: 'now',
        ...params,
      },
      mapped_params: {},
      createdBy: 'elastic',
      updatedBy: 'elastic',
      createdAt: now,
      updatedAt: now,
      apiKey: encoded,
      apiKeyOwner: 'elastic',
      apiKeyCreatedByUser: false,
      throttle: null,
      notifyWhen: null,
      muteAll: false,
      mutedInstanceIds: [],
      snoozeSchedule: [],
      scheduledTaskId: null,
      revision: 0,
      running: false,
      meta: { versionApiKeyLastmodified: KIBANA_VERSION },
      executionStatus: {
        status: 'pending',
        lastExecutionDate: now,
        error: null,
        warning: null,
      },
    });
    await client.create('alert', rule({}) as never, { id: LEGACY_RULE_ID, references: [] });
    await client.create(
      'alert',
      rule({
        workflowConfig: {
          alertRetrievalMode: 'custom_query',
          alertRetrievalWorkflowIds: [],
          alertRetrievalWorkflowsEnabled: false,
          defaultRetrievalEnabled: true,
          skillEnabled: false,
          validationWorkflowId: 'default',
        },
      }) as never,
      { id: WORKFLOW_RULE_ID, references: [] }
    );
    // The space setting that turns attack discovery workflows on, as Kibana stores it.
    await client.create(
      'config',
      { 'securitySolution:enableAttackDiscoveryWorkflows': true } as never,
      { id: KIBANA_VERSION }
    );
    // The indices of the workflows plugins and the managed workflows Kibana installed.
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
      logger: loggingSystemMock.createLogger(),
    });
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
      logger: loggingSystemMock.createLogger(),
    });
    const workflowStorage = createStorage({
      logger: loggingSystemMock.createLogger(),
      esClient: es,
    });
    for (const id of [
      ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
      ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
      ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
    ]) {
      const managed = getManagedWorkflowDefinition(id)!;
      const yaml = (managed as { yaml: string }).yaml;
      const parsed = parseYamlToJSONWithoutValidation(yaml) as { json: Record<string, unknown> };
      await workflowStorage.getClient().index({
        id,
        refresh: true,
        document: {
          name: String(parsed.json.name),
          enabled: true,
          tags: [],
          triggerTypes: [],
          yaml,
          definition: parsed.json as never,
          createdBy: 'elastic/kibana',
          lastUpdatedBy: 'elastic/kibana',
          spaceId: 'default',
          managed: true,
          managedBy: 'discoveries',
          definitionHash: computeManagedDefinitionHash(managed),
          managedVersion: managed.version,
          originManagedWorkflowId: id,
          lifecycle: 'static',
          valid: true,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        } as never,
      });
    }

    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ name }: { name: string }) => name === 'elasticAssistant__attack_discovery'
    );
    const [built] = await Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: { [built.name]: { file: `${built.name}.mjs`, taskType: TASK_TYPE } },
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
    await new Promise((resolve) => llm?.close(resolve));
  });

  it('legacy path: calls the model of the connector and persists the attack discovery', async () => {
    const result = await run(LEGACY_RULE_ID);
    expect(llmRequests.length).toBeGreaterThan(0);
    expect(result).toEqual(expect.objectContaining({ state: expect.any(Object) }));

    await es.indices.refresh({ index: '.alerts-security.attack.discovery.alerts-default*' });
    const alerts = await es.search({
      index: '.alerts-security.attack.discovery.alerts-default*',
      query: { term: { 'kibana.alert.rule.uuid': LEGACY_RULE_ID } },
    });
    expect(alerts.hits.hits.length).toBe(1);
  });

  it('workflow path: schedules a workflow:run task that carries a clone of the API key of the rule', async () => {
    // The pipeline schedules the generation workflow and then waits for Kibana to run it, which
    // nothing does here: the run is cut off, and what it scheduled is what is checked.
    await run(WORKFLOW_RULE_ID, 45000).catch(() => undefined);

    await es.indices.refresh({ index: '.kibana_task_manager' });
    const tasks = await es.search<{
      task: { taskType: string; params: string; userScope?: unknown; apiKey?: string };
    }>({
      index: '.kibana_task_manager',
      query: { term: { 'task.taskType': 'workflow:run' } },
    });
    expect(tasks.hits.hits.length).toBeGreaterThan(0);
    const { task } = tasks.hits.hits[0]._source!;
    expect(task.apiKey).toEqual(expect.any(String));
    expect(task.userScope).toEqual(expect.objectContaining({ apiKeyId: expect.any(String) }));
  });
});
