/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * A harness for the real runs of rule types in a task process (`*_task_process.test.ts`), for jest
 * integration tests only: it boots a test Elasticsearch, builds the bundles of the rule type modules
 * it is given, forks them the way Kibana does (the supervisor and `RemoteTaskRunner`), sends them
 * every setting Kibana sends a rule process, and seeds rules, connectors and API keys as Kibana
 * would have stored them.
 *
 * ```ts
 * const harness = await startRuleProcessHarness({
 *   rules: [{ taskType, bundle: 'stackAlerts__es_query' }],
 * });
 * await harness.createRule({ id: 'rule-1', ruleTypeId: '.es-query', params });
 * const { result } = await harness.run('rule-1', '.es-query'); // fails if the run was declined
 * ```
 */

// eslint-disable-next-line @kbn/eslint/require_kbn_fs
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { Client } from '@elastic/elasticsearch';
import { REPO_ROOT, kibanaPackageJson } from '@kbn/repo-info';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { configSchema as actionsConfigSchema } from '@kbn/actions-plugin/server/config';
import { createSystemConnectors } from '@kbn/actions-plugin/server/create_system_actions';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import type { TaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { RemoteTaskRunner } from '@kbn/task-manager-plugin/server/task_process/remote_task_runner';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { TaskProcessSupervisor } from '@kbn/task-manager-plugin/server/task_process/supervisor';
import type { RemoteRunObserver, RunResult } from '@kbn/task-manager-plugin/server/task';
import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import {
  ConfigSchema as SecurityConfigSchema,
  createConfig as createSecurityConfig,
} from '@kbn/security-plugin/server/config';
import { getTaskProcessSettings as getSecurityTaskProcessSettings } from '@kbn/security-plugin/server/task_plugin';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import eventLogMappings from '@kbn/event-log-plugin/generated/mappings.json';
import { configSchema as alertingConfigSchema } from '../../config';
import registeredConnectorIds from '../rule_run_connector_type_ids.json';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle, getContributionFiles } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Core, which a task process runs, refuses an Elasticsearch older than itself. */
export const KIBANA_VERSION = kibanaPackageJson.version;
export const KIBANA_UUID = '5b2de169-2785-441b-ae8c-186a1936b17d';
export const ENCRYPTION_KEY = 'a'.repeat(32);
export const EVENT_LOG_DATA_STREAM = '.kibana-event-log-ds';
export const ACTION_TASK_PARAMS_INDEX = '.kibana_alerting_cases';
export const TASK_MANAGER_INDEX = '.kibana_task_manager';

/** A preconfigured connector Kibana does not have in its config: a plugin registered it while it ran. */
export const DYNAMIC_CONNECTOR = {
  id: 'elastic-apps-slack',
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

export interface RuleModuleUnderTest {
  /** The module of the rule type, as the plugin exports it. */
  taskType: TaskTypeModule;
  /** The name of its bundle, as `getTaskBundleEntries()` names it (`stackAlerts__es_query`). */
  bundle: string;
}

export interface RuleProcessHarnessOptions {
  /** The rule types to serve. Their bundles are built in parallel, once. */
  rules: RuleModuleUnderTest[];
  /**
   * Settings of the plugins a module lists besides the ones every rule run needs (`infra`, `ml`...),
   * validated as Kibana would send them. Merged over the defaults.
   */
  settings?: Record<string, unknown>;
  /** Connectors besides the system connectors and the dynamic one Kibana has in memory. */
  inMemoryConnectors?: Array<Record<string, unknown>>;
  /** Extra indices to create (name -> mappings), before any rule runs. */
  indices?: Record<string, Record<string, unknown>>;
}

export interface SeedAction {
  group: string;
  actionTypeId: string;
  params: Record<string, unknown>;
  /** A saved connector created with `createConnector`. */
  connectorId?: string;
  /** An in-memory connector, which is not a saved object: the rule refers to it by its id. */
  inMemoryConnectorId?: string;
  frequency?: Record<string, unknown>;
}

export interface SeedRuleOptions {
  id: string;
  ruleTypeId: string;
  params: Record<string, unknown>;
  consumer?: string;
  name?: string;
  schedule?: { interval: string };
  actions?: SeedAction[];
  /** The encoded API key of the rule, from `createApiKey`. Defaults to one of the test superuser. */
  apiKey?: string;
  apiKeyOwner?: string;
  createdBy?: string;
  /** Overrides any attribute of the rule saved object. */
  attributes?: Record<string, unknown>;
}

export interface RunOptions {
  /** Called when the process declines the run or cannot serve it. Defaults to a mock that must not be called. */
  fallback?: jest.Mock;
  timeoutMs?: number;
  state?: Record<string, unknown>;
  observer?: RemoteRunObserver;
  signal?: AbortSignal;
}

export interface RunOutcome {
  result: RunResult | undefined | void;
  fallback: jest.Mock;
  /** The `RemoteTaskRunner`, for the test that cancels it. */
  runner: RemoteTaskRunner;
}

const NOT_ROUTED = 'Not a rule type module this harness serves';

export const DEFAULT_RULE_ATTRIBUTES = () => ({
  tags: [],
  legacyId: null,
  enabled: true,
  mapped_params: {},
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
});

export class RuleProcessHarness {
  public es!: Client;
  public esServer!: TestElasticsearchUtils;
  public supervisor!: TaskProcessSupervisor;
  /** Core and the module in the test process, which seeds saved objects the way Kibana stores them. */
  public seeder!: TaskProcessCore;
  public readonly kibanaVersion = KIBANA_VERSION;
  /** Connector types Kibana registered that the bundles lack: set by a test to see the run declined. */
  public unregisteredConnectorTypes: string[] = [];

  private options!: RuleProcessHarnessOptions;
  private seederClient!: ReturnType<
    TaskProcessCore['host']['savedObjects']['getUnsafeInternalClient']
  >;
  private defaultApiKey!: string;

  /** Everything Kibana sends a rule process, composed as Kibana does it. */
  public getSettings(): Record<string, unknown> {
    return {
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
      // The stack connectors plugin's config: the experimental features that change connector types.
      stackConnectors: { enableExperimental: [] },
      // Kibana's final in-memory connectors: its system connectors and the ones plugins registered
      // while Kibana ran, which the config of the process does not have.
      actionsConnectors: {
        inMemoryConnectors: [
          ...createSystemConnectors([
            { id: '.cases', name: 'Cases', isSystemActionType: true } as never,
          ]),
          DYNAMIC_CONNECTOR,
          ...(this.options.inMemoryConnectors ?? []),
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
      ...this.options.settings,
    };
  }

  /** The `init` message of a process: what Kibana sends it. */
  public getInit() {
    return {
      server: { uuid: KIBANA_UUID, buildNum: 1, isServerless: false },
      encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
      settings: Object.fromEntries(
        Object.entries(this.getSettings()).map(([id, config]) => [id, serializeSettings(config)])
      ) as never,
      // What Kibana registered, which the process must have registered too (the list that plugins
      // register is checked in next to the rule task type).
      parity: [
        {
          kind: 'connectorTypes',
          ids: [...registeredConnectorIds.connectorTypes, ...this.unregisteredConnectorTypes],
        },
        { kind: 'connectorAdapters', ids: registeredConnectorIds.connectorAdapters },
      ],
    };
  }

  public esConfig() {
    return elasticsearchConfigFromEnv({
      ES_URL: this.esServer.hosts[0],
      ES_USERNAME: this.esServer.username,
      ES_PASSWORD: this.esServer.password,
    });
  }

  public async start(options: RuleProcessHarnessOptions) {
    this.options = options;
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    // The bundles take most of the time: build them while Elasticsearch boots.
    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const names = new Set(options.rules.map(({ bundle }) => bundle));
    const entries = getTaskBundleEntries().filter(({ name }: { name: string }) => names.has(name));
    const missing = [...names].filter(
      (name) => !entries.some((entry: { name: string }) => entry.name === name)
    );
    if (missing.length) throw new Error(`No task bundle entry named ${missing.join(', ')}`);
    const building = Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    this.esServer = await startES();
    this.es = this.esServer.es.getClient();

    await this.createKibanaIndices();
    if (options.indices) {
      for (const [index, mappings] of Object.entries(options.indices)) {
        await this.es.indices.create({ index, mappings: mappings as never });
      }
    }

    // Seeds through a host of the same kind the process gets, which writes documents the way Kibana
    // does: migrated, encrypted and in the default space. It also runs rules in this process, with
    // what plugins contribute, for the tests that compare a forked run with one that is not.
    this.seeder = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: this.esConfig(),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        ...this.getInit(),
      },
      module: options.rules[0].taskType,
      contributions: this.loadContributions(),
    });
    this.seederClient = this.seeder.host.savedObjects.getUnsafeInternalClient({
      includedHiddenTypes: ['alert', 'action'],
    });
    this.defaultApiKey = await this.createApiKey();

    const built = (await building) as Array<{ name: string }>;
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: Object.fromEntries(
          options.rules.map(({ bundle, taskType }) => {
            const entry = built.find(({ name }) => name === bundle)!;
            return [entry.name, { file: `${entry.name}.js`, taskType: taskType.type }];
          })
        ),
      })
    );
    this.supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: bundleDir,
        kibanaVersion: KIBANA_VERSION,
        getElasticsearchConfig: () => this.esConfig(),
        getInitFor: () => this.getInit(),
      },
      logger: loggingSystemMock.createLogger(),
    });
    this.supervisor.start();
  }

  public async stop() {
    await this.supervisor?.stop();
    await this.seeder?.stop();
    await this.esServer?.stop();
  }

  /** What plugins contribute to rule runs, which the bundle builder imports into each bundle. */
  private loadContributions() {
    return {
      'alerting-rule-run': getContributionFiles('alerting-rule-run').map(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        (file: string) => require(file).contribution
      ),
    };
  }

  /**
   * The indices and aliases Kibana's migrator would have created for the saved object types a rule
   * run uses, with their real mappings, and the event log data stream, which Kibana owns.
   */
  private async createKibanaIndices() {
    const indexMappings = new Map<string, Record<string, unknown>>();
    for (const { taskType } of this.options.rules) {
      for (const type of taskType.savedObjectTypes ?? []) {
        const index = type.indexPattern ?? '.kibana';
        indexMappings.set(index, {
          ...(indexMappings.get(index) ?? {}),
          [type.name]: type.mappings,
        });
      }
    }
    indexMappings.set(TASK_MANAGER_INDEX, {
      ...(indexMappings.get(TASK_MANAGER_INDEX) ?? {}),
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
      await this.es.indices.create({
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
    await this.es.indices.putIndexTemplate({
      name: '.kibana-event-log-template',
      index_patterns: ['.kibana-event-log-*'],
      data_stream: { hidden: true },
      priority: 100,
      template: { mappings: eventLogMappings as never },
    });
    await this.es.indices.createDataStream({ name: EVENT_LOG_DATA_STREAM });
  }

  // ---- seeding ----------------------------------------------------------------------------------

  /** A client of Elasticsearch that acts as this user. */
  public clientAs(username: string, password: string) {
    return new Client({ node: this.esServer.hosts[0], auth: { username, password } });
  }

  /** An API key as Kibana stores it for a rule: of the superuser, or of the user given. */
  public async createApiKey(as?: { username: string; password: string }): Promise<string> {
    const client = as ? this.clientAs(as.username, as.password) : this.es;
    const { encoded } = await client.security.createApiKey({ name: `rule-key-${Date.now()}` });
    return encoded;
  }

  public async createConnector(
    id: string,
    { actionTypeId = '.server-log', config = {}, secrets = {} } = {}
  ) {
    await this.seederClient.create(
      'action',
      {
        name: id,
        actionTypeId,
        isMissingSecrets: false,
        config,
        secrets,
      },
      { id }
    );
  }

  /** Stores a rule as Kibana does, encrypted with the key the process is sent. */
  public async createRule(options: SeedRuleOptions) {
    const references: Array<{ id: string; name: string; type: string }> = [];
    const actions = (options.actions ?? []).map((action, i) => {
      let connector: Record<string, unknown>;
      if (action.connectorId) {
        references.push({ id: action.connectorId, name: `action_${i}`, type: 'action' });
        connector = { actionRef: `action_${i}` };
      } else {
        connector = { actionRef: `preconfigured:${action.inMemoryConnectorId}` };
      }
      return {
        group: action.group,
        ...connector,
        actionTypeId: action.actionTypeId,
        params: action.params,
        uuid: `action-uuid-${i}`,
        frequency: action.frequency ?? {
          summary: false,
          notifyWhen: 'onActiveAlert',
          throttle: null,
        },
      };
    });
    const now = new Date().toISOString();
    await this.seederClient.create(
      'alert',
      {
        ...DEFAULT_RULE_ATTRIBUTES(),
        name: options.name ?? options.id,
        alertTypeId: options.ruleTypeId,
        consumer: options.consumer ?? 'alerts',
        schedule: options.schedule ?? { interval: '1m' },
        actions,
        params: options.params,
        createdBy: options.createdBy ?? 'elastic',
        updatedBy: options.createdBy ?? 'elastic',
        createdAt: now,
        updatedAt: now,
        apiKey: options.apiKey ?? this.defaultApiKey,
        apiKeyOwner: options.apiKeyOwner ?? 'elastic',
        executionStatus: {
          status: 'pending',
          lastExecutionDate: now,
          error: null,
          warning: null,
        },
        ...options.attributes,
      } as never,
      { id: options.id, references }
    );
    return options.id;
  }

  /**
   * Registers privileges in Elasticsearch the way Kibana does when it starts (a process does not),
   * and a role and user that hold some of them. Returns the credentials of the user.
   */
  public async createUserWithPrivileges(
    username: string,
    privileges: Record<string, string[]>,
    granted: string[]
  ) {
    await this.es.security.putPrivileges({
      privileges: {
        'kibana-.kibana': Object.fromEntries(
          Object.entries(privileges).map(([name, actions]) => [name, { actions }])
        ),
      },
    });
    await this.es.security.putRole({
      name: `${username}-role`,
      cluster: ['manage_api_key'],
      indices: [{ names: ['*'], privileges: ['all'] }],
      applications: [
        { application: 'kibana-.kibana', privileges: granted, resources: ['space:default'] },
      ],
    });
    const password = 'changeme-password';
    await this.es.security.putUser({ username, password, roles: [`${username}-role`] });
    return { username, password };
  }

  // ---- running ----------------------------------------------------------------------------------

  public taskInstanceOf(ruleId: string, ruleTypeId: string, state: Record<string, unknown> = {}) {
    const taskType = `alerting:${ruleTypeId}`;
    const now = new Date().toISOString();
    return {
      id: ruleId,
      taskType,
      params: { alertId: ruleId, spaceId: 'default', consumer: 'alerts' },
      state,
      attempts: 0,
      status: 'running',
      scheduledAt: now,
      runAt: now,
      startedAt: now,
      retryAt: null,
      ownerId: null,
    };
  }

  /**
   * Runs a rule through `RemoteTaskRunner` as Task Manager does, in a process forked by the supervisor.
   * Fails when the run was declined (the fallback was called), unless the test passes its own fallback.
   */
  public createRunner(ruleId: string, ruleTypeId: string, options: RunOptions = {}) {
    const taskType = `alerting:${ruleTypeId}`;
    const fallback =
      options.fallback ??
      jest.fn().mockReturnValue({ run: async () => ({ state: { declinedToKibana: true } }) });
    const runner = new RemoteTaskRunner({
      route: this.supervisor.getRoute(taskType)!,
      request: {
        taskType,
        taskInstance: this.taskInstanceOf(ruleId, ruleTypeId, options.state) as never,
        executionUuid: `${ruleId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: options.timeoutMs ?? 120000,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
      fallback: fallback as never,
      observer: options.observer,
      signal: options.signal,
    });
    return { runner, fallback };
  }

  public async run(
    ruleId: string,
    ruleTypeId: string,
    options: RunOptions = {}
  ): Promise<RunOutcome> {
    const { runner, fallback } = this.createRunner(ruleId, ruleTypeId, options);
    const result = await runner.run();
    if (!options.fallback && fallback.mock.calls.length) {
      throw new Error(
        `The run of ${ruleId} (${ruleTypeId}) was declined: Kibana would have run it`
      );
    }
    return { result, fallback, runner };
  }

  /**
   * Runs the rule in this process instead of a forked one, with the same module, the same settings
   * and the same contributions: what Kibana's own runtime would do, minus the process boundary.
   */
  public async runInProcess(
    ruleId: string,
    ruleTypeId: string,
    state: Record<string, unknown> = {}
  ) {
    const taskType = `alerting:${ruleTypeId}`;
    const definition = this.seeder.definitions.get(taskType);
    if (!definition) throw new Error(`${NOT_ROUTED}: ${taskType}`);
    const task = definition.createTaskRunner({
      taskInstance: this.taskInstanceOf(ruleId, ruleTypeId, state) as never,
      fakeRequest: undefined,
      signal: new AbortController().signal,
      executionUuid: `${ruleId}-in-process-${Date.now()}`,
      setCustomTaskRunEventFields: jest.fn(),
    } as never);
    try {
      return await task.run();
    } finally {
      await this.seeder.flush();
    }
  }

  // ---- assertions -------------------------------------------------------------------------------

  public async getAlertDocs(index: string, ruleId: string) {
    await this.es.indices.refresh({ index });
    const { hits } = await this.es.search<Record<string, unknown>>({
      index,
      query: { term: { 'kibana.alert.rule.uuid': ruleId } },
      size: 100,
    });
    return hits.hits.map((hit) => hit._source!);
  }

  /**
   * The event log documents of a rule. The process flushes the events it buffers when it stops, which
   * is right after the run, so this waits until `until` holds (default: the execute event is there).
   */
  public async getEventDocs(
    ruleId: string,
    until: (docs: Array<Doc>) => boolean = (docs) =>
      docs.some((doc) => doc.event?.action === 'execute')
  ) {
    const search = async () => {
      await this.es.indices.refresh({ index: EVENT_LOG_DATA_STREAM });
      const { hits } = await this.es.search<Doc>({
        index: EVENT_LOG_DATA_STREAM,
        query: { term: { 'rule.id': ruleId } },
        sort: [{ '@timestamp': 'asc' }],
        size: 100,
      });
      return hits.hits.map((hit) => hit._source!);
    };
    let docs = await search();
    for (let i = 0; i < 40 && !until(docs); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      docs = await search();
    }
    return docs;
  }

  /** The `action_task_params` saved objects and the `actions:*` tasks a run enqueued for Kibana. */
  public async getEnqueued() {
    await this.es.indices.refresh({ index: [TASK_MANAGER_INDEX, ACTION_TASK_PARAMS_INDEX] });
    const tasks = await this.es.search<{ task: { taskType: string } }>({
      index: TASK_MANAGER_INDEX,
      query: { prefix: { 'task.taskType': 'actions:' } },
      size: 100,
    });
    const params = await this.es.search<{ action_task_params: Doc }>({
      index: ACTION_TASK_PARAMS_INDEX,
      query: { term: { type: 'action_task_params' } },
      size: 100,
    });
    return {
      tasks: tasks.hits.hits.map((hit) => hit._source!.task),
      actionTaskParams: params.hits.hits.map((hit) => hit._source!.action_task_params),
    };
  }
}

export const startRuleProcessHarness = async (options: RuleProcessHarnessOptions) => {
  const harness = new RuleProcessHarness();
  await harness.start(options);
  return harness;
};

const VOLATILE_KEYS = new Set([
  '@timestamp',
  'event.start',
  'event.end',
  'event.duration',
  'event.created',
  'kibana.alert.uuid',
  'kibana.alert.start',
  'kibana.alert.end',
  'kibana.alert.time_range',
  'kibana.alert.last_detected',
  'kibana.alert.duration.us',
  'kibana.alert.rule.execution.uuid',
  'kibana.alert.rule.execution.timestamp',
  'kibana.alert.instance.id',
  'kibana.version',
  'kibana.alert.workflow_status_updated_at',
  'kibana.space_ids',
]);

/** Drops what changes from run to run (ids, times, durations) so two runs can be compared. */
export const stripVolatile = (value: unknown, path = ''): unknown => {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, path));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEYS.has(path ? `${path}.${key}` : key))
        .filter(([key]) => !/(^|\.)(uuid|id|timestamp|duration|ms|ns|time|start|end)$/i.test(key))
        .map(([key, item]) => [key, stripVolatile(item, path ? `${path}.${key}` : key)])
    );
  }
  return value;
};

/** The parts of an event log document that say what happened, without the volatile fields. */
export const summarizeEvent = (doc: Doc) => ({
  action: doc.event?.action,
  outcome: doc.event?.outcome,
  kind: doc.event?.kind,
  provider: doc.event?.provider,
  reason: doc.event?.reason,
  message: doc.message,
  error: doc.error?.message,
});
