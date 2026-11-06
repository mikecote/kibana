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
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import {
  ConfigSchema as SecurityConfigSchema,
  createConfig as createSecurityConfig,
} from '@kbn/security-plugin/server/config';
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import eventLogMappings from '@kbn/event-log-plugin/generated/mappings.json';
import { createSystemConnectors } from '@kbn/actions-plugin/server/create_system_actions';
import registeredConnectorIds from '@kbn/alerting-plugin/server/task_types/rule_run_connector_type_ids.json';
import { taskType } from '../task_types/es_query.task';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

// Core, which a task process runs, refuses an Elasticsearch older than itself.
const KIBANA_VERSION = kibanaPackageJson.version;
const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
const ENCRYPTION_KEY = 'a'.repeat(32);
const TASK_TYPE = 'alerting:.es-query';
const SOURCE_INDEX = 'es-query-source';
const RULE_ID = 'rule-1';
const CASES_RULE_ID = 'rule-with-cases';
const UNKNOWN_RULE_ID = 'rule-with-unknown-action';
const CONNECTOR_ID = 'server-log-1';
const DYNAMIC_CONNECTOR_ID = 'elastic-apps-slack';
const DYNAMIC_RULE_ID = 'rule-with-dynamic-connector';
const DYNAMIC_CONNECTOR = {
  id: DYNAMIC_CONNECTOR_ID,
  name: 'Elastic apps',
  actionTypeId: '.server-log',
  config: {},
  secrets: {},
  isDeprecated: false,
  isConnectorTypeDeprecated: false,
  isPreconfigured: true,
  isSystemAction: false,
  isDynamic: true,
};
const ALERTS_INDEX = '.alerts-stack.alerts-default';

/**
 * Runs the `.es-query` rule type from its own bundle, forked by the supervisor the way Kibana does,
 * against a real Elasticsearch: the process decrypts the rule with the encryption key it is sent,
 * runs the executor, writes the alert and the event log, and enqueues the action task for Kibana.
 */
describe('the .es-query rule type served from a bundle', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let seeder: Awaited<ReturnType<typeof startTaskProcessCore>>;

  const settings = () => ({
    alerting: alertingConfigSchema.validate({}),
    actions: actionsConfigSchema.validate({}),
    // What Kibana decided while it started from the plugins around alerting.
    alertingRun: {
      maintenanceWindowsEnabled: true,
      dataViews: { scriptedFieldsEnabled: true },
      search: { searchConfig: searchConfigSchema.validate({}), rollupsEnabled: false },
    },
    // What Kibana sends for the cases system action, which cases contributes to every rule run.
    cases: { isCasesAttachmentsEnabled: true, isTemplatesEnabled: false },
    // Kibana's final in-memory connectors: its system connectors and one that a plugin registered
    // while Kibana ran, which the config of the process does not have.
    actionsConnectors: {
      inMemoryConnectors: [
        ...createSystemConnectors([
          { id: '.cases', name: 'Cases', isSystemActionType: true } as never,
        ]),
        DYNAMIC_CONNECTOR,
      ],
    },
    // The security plugin's task plugin, which every rule run brings for the privileges of connectors.
    security: getSecurityTaskProcessSettings({
      config: createSecurityConfig(
        SecurityConfigSchema.validate({ audit: { enabled: false } }),
        loggingSystemMock.create().get(),
        { isTLSEnabled: false }
      ),
      applicationName: 'kibana-.kibana',
      kibanaServerResourceURL: 'http://localhost:5601',
    }),
  });

  // Connector types Kibana registered that this process does not: set by a test to see the run declined.
  let unregisteredConnectorTypes: string[] = [];

  const initFor = () => ({
    server: { uuid: KIBANA_UUID, buildNum: 1, isServerless: false },
    encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
    settings: Object.fromEntries(
      Object.entries(settings()).map(([id, config]) => [id, serializeSettings(config)])
    ) as never,
    // What Kibana registered, which the process must have registered too (the list that plugins
    // register is checked in next to the rule task type).
    parity: [
      {
        kind: 'connectorTypes',
        ids: [...registeredConnectorIds.connectorTypes, ...unregisteredConnectorTypes],
      },
      { kind: 'connectorAdapters', ids: registeredConnectorIds.connectorAdapters },
    ],
  });

  const run = (ruleId: string, fallback?: jest.Mock) =>
    new RemoteTaskRunner({
      route: supervisor.getRoute(TASK_TYPE)!,
      request: {
        taskType: TASK_TYPE,
        taskInstance: {
          id: ruleId,
          taskType: TASK_TYPE,
          params: { alertId: ruleId, spaceId: 'default', consumer: 'alerts' },
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
      includedHiddenTypes: ['alert', 'action'],
    });
    const { encoded } = await es.security.createApiKey({ name: 'rule-key' });
    await client.create(
      'action',
      {
        name: 'server log',
        actionTypeId: '.server-log',
        isMissingSecrets: false,
        config: {},
        secrets: {},
      },
      { id: CONNECTOR_ID }
    );
    const rule = (
      actionTypeId: string,
      params: Record<string, unknown>,
      // An in-memory connector is not a saved object: the rule refers to it by its id, without a reference.
      connector: Record<string, unknown> = { actionRef: 'action_0' }
    ) => ({
      name: 'es query rule',
      tags: [],
      alertTypeId: '.es-query',
      consumer: 'alerts',
      legacyId: null,
      schedule: { interval: '1m' },
      enabled: true,
      actions: [
        {
          group: 'query matched',
          ...connector,
          actionTypeId,
          params,
          uuid: 'action-uuid-1',
          frequency: { summary: false, notifyWhen: 'onActiveAlert', throttle: null },
        },
      ],
      params: {
        index: [SOURCE_INDEX],
        timeField: '@timestamp',
        esQuery: '{"query":{"match_all":{}}}',
        size: 100,
        timeWindowSize: 1,
        timeWindowUnit: 'h',
        threshold: [0],
        thresholdComparator: '>',
        searchType: 'esQuery',
        excludeHitsFromPreviousRun: false,
        aggType: 'count',
        groupBy: 'all',
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
    });
    const references = [{ id: CONNECTOR_ID, name: 'action_0', type: 'action' }];
    await client.create(
      'alert',
      rule('.server-log', { level: 'info', message: 'matched {{context.title}}' }) as never,
      { id: RULE_ID, references }
    );
    await client.create(
      'alert',
      rule('.cases', { subAction: 'run', subActionParams: {} }) as never,
      { id: CASES_RULE_ID, references }
    );
    await client.create(
      'alert',
      rule(
        '.server-log',
        { level: 'info', message: 'dynamic {{context.title}}' },
        { actionRef: `preconfigured:${DYNAMIC_CONNECTOR_ID}` }
      ) as never,
      { id: DYNAMIC_RULE_ID, references: [] }
    );
    await client.create('alert', rule('.does-not-exist', {}) as never, {
      id: UNKNOWN_RULE_ID,
      references,
    });
    await es.index({
      index: SOURCE_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': new Date().toISOString(), message: 'hello' },
    });

    // Builds the bundle of the rule type and serves it the way Kibana does.
    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ name }: { name: string }) => name === 'stackAlerts__es_query'
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

  it('declares what its process needs and what it is, from its module file', () => {
    expect(taskType.type).toBe(TASK_TYPE);
    expect(taskType.settings).toEqual(['alerting', 'actions', 'security', 'alertingRun']);
    expect(taskType.encryptedSavedObjectTypes?.map((t) => t.type).sort()).toEqual([
      'action',
      'action_task_params',
      'alert',
    ]);
  });

  it('runs the rule, writes the alert and the event log, and enqueues the action for Kibana', async () => {
    const result = await run(RULE_ID);
    expect(result).toEqual(
      expect.objectContaining({ schedule: { interval: '1m' }, state: expect.any(Object) })
    );

    await es.indices.refresh({ index: [ALERTS_INDEX, '.kibana-event-log-ds'].join(',') });

    const alerts = await es.search({
      index: ALERTS_INDEX,
      query: { term: { 'kibana.alert.rule.uuid': RULE_ID } },
    });
    expect(alerts.hits.hits.length).toBeGreaterThan(0);

    // The process flushes the events it buffers when it stops, which is right after the run.
    const searchEvents = () =>
      es.search<{ event: { action: string }; kibana: { server_uuid: string } }>({
        index: '.kibana-event-log-ds',
        query: { term: { 'rule.id': RULE_ID } },
        size: 50,
      });
    let events = await searchEvents();
    for (let i = 0; i < 30 && events.hits.hits.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await es.indices.refresh({ index: '.kibana-event-log-ds' });
      events = await searchEvents();
    }
    const actions = events.hits.hits.map((hit) => hit._source!.event.action);
    expect(actions).toEqual(expect.arrayContaining(['execute-start', 'execute']));
    expect(events.hits.hits[0]._source!.kibana.server_uuid).toBe(KIBANA_UUID);

    await es.indices.refresh({ index: ['.kibana_task_manager', '.kibana_alerting_cases'] });
    const tasks = await es.search({
      index: '.kibana_task_manager',
      query: { term: { 'task.taskType': 'actions:.server-log' } },
    });
    expect(tasks.hits.hits.length).toBe(1);
    const params = await es.search({
      index: '.kibana_alerting_cases',
      query: { term: { type: 'action_task_params' } },
    });
    expect(params.hits.hits.length).toBe(1);
  });

  it('serves a rule that uses the cases system action, which cases contributes to the process', async () => {
    const fallback = jest.fn();
    await run(CASES_RULE_ID, fallback);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('enqueues the action of a connector that Kibana registered while it ran, as sent, not rebuilt from config', async () => {
    const fallback = jest.fn();
    await run(DYNAMIC_RULE_ID, fallback);
    expect(fallback).not.toHaveBeenCalled();

    await es.indices.refresh({ index: '.kibana_alerting_cases' });
    const params = await es.search<{ action_task_params: { actionId: string } }>({
      index: '.kibana_alerting_cases',
      query: { term: { type: 'action_task_params' } },
      size: 50,
    });
    expect(
      params.hits.hits.filter(
        (hit) => hit._source?.action_task_params.actionId === DYNAMIC_CONNECTOR_ID
      )
    ).toHaveLength(1);
  });

  it('declines every run, before anything is written, when Kibana registered a connector type the process lacks', async () => {
    unregisteredConnectorTypes = ['.registered-after-the-bundle-was-built'];
    try {
      const fallback = jest.fn().mockReturnValue({ run: async () => ({ state: { local: true } }) });
      await expect(run(RULE_ID, fallback)).resolves.toEqual({ state: { local: true } });
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally {
      unregisteredConnectorTypes = [];
    }
  });

  it('declines a rule that uses an action type it does not know, so Kibana runs it', async () => {
    const fallback = jest.fn().mockReturnValue({ run: async () => ({ state: { local: true } }) });
    await expect(run(UNKNOWN_RULE_ID, fallback)).resolves.toEqual({ state: { local: true } });
    expect(fallback).toHaveBeenCalledTimes(1);
    const alerts = await es.search({
      index: ALERTS_INDEX,
      query: { term: { 'kibana.alert.rule.uuid': UNKNOWN_RULE_ID } },
    });
    expect(alerts.hits.hits).toHaveLength(0);
  });
});
