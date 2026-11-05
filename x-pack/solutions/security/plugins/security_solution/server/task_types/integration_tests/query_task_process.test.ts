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
import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server';
import { ConfigSchema as listsConfigSchema } from '@kbn/lists-plugin/server/config';
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
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { createMockConfig } from '../../config.mock';
import { getTaskProcessSettings } from '../../config';
import { taskType } from '../query.task';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

// Core, which a task process runs, refuses an Elasticsearch older than itself.
const KIBANA_VERSION = kibanaPackageJson.version;
const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
const ENCRYPTION_KEY = 'a'.repeat(32);
const TASK_TYPE = 'alerting:siem.queryRule';
const SOURCE_INDEX = 'security-source';
const RULE_ID = 'rule-1';
const ALERTS_INDEX = '.alerts-security.alerts-default';

/**
 * Runs the `siem.queryRule` detection rule type from its own bundle, forked by the supervisor the way
 * Kibana does, against a real Elasticsearch: the process decrypts the rule, runs the security rule
 * type wrapper and the query executor, writes the alert with the rule data client and the rule
 * execution events to the event log.
 */
describe('the siem.queryRule rule type served from a bundle', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let seeder: Awaited<ReturnType<typeof startTaskProcessCore>>;

  const settings = () => ({
    alerting: alertingConfigSchema.validate({}),
    actions: actionsConfigSchema.validate({}),
    // What Kibana sends for the cases system action, which cases contributes to every rule run.
    cases: { isCasesAttachmentsEnabled: true, isTemplatesEnabled: false },
    securitySolution: getTaskProcessSettings(createMockConfig()),
    ruleRegistry: ruleRegistryConfig.schema.validate({}),
    lists: listsConfigSchema.validate({}),
    // What Kibana sends for the security task plugin of the process.
    security: getSecurityTaskProcessSettings({
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

  const run = (ruleId: string, fallback?: jest.Mock) =>
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
      timeoutMs: 120000,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
      fallback: fallback as never,
    }).run();

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

    // The indices and aliases Kibana's migrator would have created for the saved object types a rule
    // run uses, with their real mappings.
    const indexMappings = new Map<string, Record<string, unknown>>();
    for (const type of taskType.savedObjectTypes ?? []) {
      const index = type.indexPattern ?? '.kibana';
      indexMappings.set(index, {
        ...(indexMappings.get(index) ?? {}),
        [type.name]: type.mappings,
      });
    }
    // The `config` document of ui settings, which a run reads and Kibana would have created.
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
    // The event log data stream, which Kibana owns.
    await es.indices.putIndexTemplate({
      name: '.kibana-event-log-template',
      index_patterns: ['.kibana-event-log-*'],
      data_stream: { hidden: true },
      priority: 100,
      template: { mappings: eventLogMappings as never },
    });
    await es.indices.createDataStream({ name: '.kibana-event-log-ds' });

    // Seeds through a host of the same kind the process gets, which writes documents the way Kibana
    // does: migrated, encrypted and in the default space.
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
      includedHiddenTypes: ['alert'],
    });
    const { encoded } = await es.security.createApiKey({ name: 'rule-key' });
    await client.create(
      'alert',
      {
        name: 'query rule',
        tags: [],
        alertTypeId: 'siem.queryRule',
        consumer: 'siem',
        legacyId: null,
        schedule: { interval: '1m' },
        enabled: true,
        actions: [],
        params: {
          author: [],
          description: 'Matches everything in the source index',
          ruleId: 'rule-1-uuid',
          falsePositives: [],
          from: 'now-1h',
          immutable: false,
          ruleSource: { type: 'internal' },
          license: '',
          outputIndex: '',
          maxSignals: 100,
          riskScore: 21,
          riskScoreMapping: [],
          severity: 'low',
          severityMapping: [],
          threat: [],
          to: 'now',
          references: [],
          version: 1,
          exceptionsList: [],
          relatedIntegrations: [],
          requiredFields: [],
          setup: '',
          type: 'query',
          language: 'kuery',
          query: '*:*',
          index: [SOURCE_INDEX],
          filters: [],
        },
        mapped_params: {},
        createdBy: 'elastic',
        updatedBy: 'elastic',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
          lastExecutionDate: new Date().toISOString(),
          error: null,
          warning: null,
        },
      } as never,
      { id: RULE_ID, references: [] }
    );
    await es.index({
      index: SOURCE_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': new Date().toISOString(), message: 'hello' },
    });

    // Builds the bundle of the rule type and serves it the way Kibana does.
    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ name }: { name: string }) => name === 'securitySolution__query'
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
    await seeder?.stop();
    await esServer?.stop();
  });

  it('declares what its process needs, from its module file', () => {
    expect(taskType.type).toBe(TASK_TYPE);
    expect(taskType.settings).toEqual(
      expect.arrayContaining(['alerting', 'actions', 'securitySolution', 'ruleRegistry'])
    );
  });

  it('runs the rule, writes the alert and the rule execution events', async () => {
    const fallback = jest.fn();
    const result = await run(RULE_ID, fallback);
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ schedule: { interval: '1m' }, state: expect.any(Object) })
    );

    await es.indices.refresh({ index: [ALERTS_INDEX, '.kibana-event-log-ds'].join(',') });

    const alerts = await es.search({
      index: ALERTS_INDEX,
      query: { term: { 'kibana.alert.rule.uuid': RULE_ID } },
    });
    expect(alerts.hits.hits.length).toBe(1);

    // The process flushes the events it buffers when it stops, which is right after the run.
    const searchEvents = () =>
      es.search<{ event: { action: string; provider: string } }>({
        index: '.kibana-event-log-ds',
        query: {
          bool: {
            filter: [
              { term: { 'rule.id': RULE_ID } },
              { term: { 'event.provider': 'securitySolution.ruleExecution' } },
            ],
          },
        },
        size: 50,
      });
    let events = await searchEvents();
    for (let i = 0; i < 30 && events.hits.hits.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await es.indices.refresh({ index: '.kibana-event-log-ds' });
      events = await searchEvents();
    }
    const actions = events.hits.hits.map((hit) => hit._source!.event.action);
    expect(actions).toEqual(expect.arrayContaining(['status-change', 'execution-metrics']));
  });
});
