/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, SavedObjectsType } from '@kbn/core/server';
import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import { stateSchemaByVersion } from '@kbn/alerting-state-types';
import { kibanaPackageJson } from '@kbn/repo-info';
import { createSecurityTaskPlugin } from '@kbn/security-plugin/server/task_plugin';
import { CONNECTOR_TYPES_PARITY_KIND } from '@kbn/actions-plugin/server/task_types/task_process_settings';
import { events as actionsEventTypes } from '@kbn/actions-plugin/server/lib/event_based_telemetry';
import { createTelemetryTaskPlugin } from '@kbn/telemetry-plugin/server/task_plugin';
import type { RunContext } from '@kbn/task-manager-plugin/server';
import { DeclinedRunError } from '@kbn/task-manager-plugin/server/task_running/errors';
import {
  defineTaskType,
  type TaskHost,
  type TaskTypeModule,
} from '@kbn/task-manager-plugin/server/task_type_module';
import { TaskTypeGroup } from '@kbn/task-manager-plugin/server/task';
import type { CancellableTask } from '@kbn/task-manager-plugin/server/task';
import { createStandaloneEventLog } from '@kbn/event-log-plugin/server/standalone_event_log';
import { UrlService } from '@kbn/share-plugin/common/url_service';
import type { LocatorClient, LocatorDefinition } from '@kbn/share-plugin/common/url_service';
import {
  EVENT_LOG_ACTIONS as ACTIONS_EVENT_LOG_ACTIONS,
  EVENT_LOG_PROVIDER as ACTIONS_EVENT_LOG_PROVIDER,
} from '@kbn/actions-plugin/server/constants/event_log';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import type { FieldFormatsStart } from '@kbn/field-formats-plugin/server';
import type { ConnectorAdapter } from '../connector_adapters/types';
import type { AlertingConfig } from '../config';
import { EVENT_LOG_ACTIONS, EVENT_LOG_PROVIDER } from '../constants/event_log';
import { normalizeRuleType, RULE_TYPES_WITH_CUSTOM_COST } from '../lib/normalize_rule_type';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import { RULE_SAVED_OBJECT_TYPE } from '../saved_objects';
import { TaskRunner } from '../task_runner/task_runner';
import type { RuleRunRuntime } from '../task_runner/types';
import type { UntypedRuleType } from '../types';
import { ruleTaskParamsSchema } from './rule_task_params_schema';
import { getRuleRunDeclarations } from './rule_run_saved_object_types';
import { getRuleRunUiSettings } from './rule_run_ui_settings';
import { RULE_RUN_CONTRIBUTIONS } from './rule_run_contribution';
import { CONNECTOR_ADAPTERS_PARITY_KIND } from './parity_kinds';
import { ALERTING_RUN_SETTINGS_ID } from './rule_run_settings';
import { observeRemoteRuleRun } from './remote_run_metrics';
import type { RuleRunContribution } from './rule_run_contribution';

export { ruleTaskParamsSchema };

/** What the factory of a rule type may use when a task process builds it: the host, nothing else. */
export interface RuleTypeModuleDeps {
  logger: Logger;
  isServerless: boolean;
  kibanaVersion: string;
  publicBaseUrl?: string;
  /** The validated configs of the plugins the module lists, such as `settings.alerting`. */
  settings: Record<string, unknown>;
  /** The locators the module lists, for rule types that build links with them. */
  locators: LocatorClient;
  /** What the process runs on, for factories that build the services a rule type uses. */
  host: TaskHost;
  /** The services of a rule run, which the rule type may use once it runs; not while it is built. */
  runtime: RuleRunRuntime;
  fieldFormats: FieldFormatsStart;
}

export interface RuleTaskTypeOptions {
  /**
   * Kibana: the runtime of the alerting plugin, once it has started. Without it, which is what a task
   * process does, the runtime is built from the host.
   */
  getRuntime?: () => Promise<RuleRunRuntime>;
  /** A task process only: the locators the executor of this rule type reads from `share`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locators?: Array<LocatorDefinition<any>>;
  /**
   * A task process only: registers locators that need other locators, such as one that builds its
   * path with the management locator. Runs after `locators` are created.
   */
  registerLocators?: (locators: LocatorClient) => void;
  /** A task process only: the connector adapters rules of this rule type may use. */
  connectorAdapters?: ConnectorAdapter[];
  /** A task process only: saved object types the executor reads, besides what every rule run reads. */
  savedObjectTypes?: SavedObjectsType[];
  /** A task process only: encrypted saved objects the executor reads, besides what every rule run reads. */
  encryptedSavedObjectTypes?: EncryptedSavedObjectTypeRegistration[];
  /** A task process only: event log providers the executor writes with, besides alerting's own. */
  eventLogProviders?: Array<{ provider: string; actions: string[] }>;
  /**
   * A task process only: analytics event types the executor reports, which Core's analytics requires
   * to be registered (the plugin that owns the rule type registers them in Kibana).
   */
  analyticsEventTypes?: TaskTypeModule['analyticsEventTypes'];
  /** A task process only: ids of plugins whose config the executor reads, besides alerting and actions. */
  settings?: string[];
  /** Settings from optional plugins, captured when those plugins are enabled. */
  optionalSettings?: string[];
  /** A task process only: ui settings defaults the executor reads, besides those every rule run reads. */
  uiSettings?: Array<Record<string, UiSettingsParams>>;
  /**
   * A task process only: the rule type runs connectors itself, such as attack discovery calling the
   * connector of a model, so the actions executor is initialized in the process (its connector types
   * come from the contributions of the plugins that own them). Without it a run only enqueues actions.
   */
  executeConnectors?: boolean;
  /**
   * A task process only: task types besides `actions:*` that the rule type schedules, such as the
   * `workflow:run` tasks of attack discovery.
   */
  schedulableTaskTypes?: RegExp[];
  /**
   * Validates process execution prerequisites before side effects; a returned reason fails the run.
   * It reads the dispatch settings and rule parameters.
   */
  declineRun?: (info: {
    settings: Record<string, unknown>;
    ruleParams: Record<string, unknown>;
  }) => string | undefined;
  /**
   * A task process only: plugins that run next to Core, such as the security plugin that registers
   * the security delegate. The factory of the rule type reads what they return as `host.plugins[id]`.
   */
  taskPlugins?: TaskTypeModule['taskPlugins'];
}

export type RuleTypeSource =
  /** Kibana: the rule type as `RuleTypeRegistry` keeps it. */
  | { ruleType: UntypedNormalizedRuleType }
  /** A task process: how to build the rule type from the host, and its id without building it. */
  | { ruleTypeId: string; getRuleType: (deps: RuleTypeModuleDeps) => UntypedRuleType };

interface PreparedRuleRun {
  runtime: RuleRunRuntime;
  unsupportedActionTypes?: (ids: string[]) => string[];
  connectorTypeIds?: () => string[];
  connectorAdapterIds?: () => string[];
}

const createUrlService = (
  host: Pick<TaskHost, 'server'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locators: Array<LocatorDefinition<any>> = [],
  registerLocators?: (locators: LocatorClient) => void
) => {
  const urlService = new UrlService({
    baseUrl: host.server.publicBaseUrl ?? '',
    version: host.server.version,
    navigate: async () => {
      throw new Error('Locator .navigate() is not supported in a task process.');
    },
    getUrl: async () => {
      throw new Error('Locator .getUrl() is not supported in a task process.');
    },
    // Built when the service is, but only failing when a short URL is used.
    shortUrls: () => ({
      get: () =>
        new Proxy(
          {},
          {
            get: () => () => {
              throw new Error('Short URLs are not supported in a task process.');
            },
          }
        ),
    }),
  } as never);
  locators.forEach((locator) => urlService.locators.create(locator));
  registerLocators?.(urlService.locators);
  return urlService;
};

type HostForRuleType = Pick<TaskHost, 'logger' | 'server' | 'settings'>;

/** A rule task type module, which also says which rule type it builds. */
export type RuleTaskTypeModule = TaskTypeModule & {
  /** Builds the rule type the way a task process does; for tests that compare it with Kibana's. */
  buildRuleType: (host: HostForRuleType) => UntypedNormalizedRuleType;
};

/**
 * The task type of a rule type, `alerting:<id>`, as a task type module. Kibana builds it from the
 * registered rule type and runs it with the alerting plugin's own services. A task process builds it
 * from the rule type factory of the plugin that owns the rule type, with services built from the
 * host, and runs the same `TaskRunner`.
 */
export function createRuleTaskType(
  source: RuleTypeSource,
  options: RuleTaskTypeOptions = {},
  /** A task process: what other plugins add to a rule run, such as connector types of system actions. */
  contributions: RuleRunContribution[] = []
): RuleTaskTypeModule {
  const kibanaRuleType = 'ruleType' in source ? source.ruleType : undefined;
  const id = kibanaRuleType ? kibanaRuleType.id : (source as { ruleTypeId: string }).ruleTypeId;
  const cost = RULE_TYPES_WITH_CUSTOM_COST[id];

  let ruleType: UntypedNormalizedRuleType | undefined = kibanaRuleType;
  let urlService: UrlService | undefined;
  const buildRuleType = (
    host: HostForRuleType,
    services: Partial<Pick<RuleTypeModuleDeps, 'runtime' | 'fieldFormats'>> = {}
  ) => {
    urlService ??= createUrlService(host, options.locators, options.registerLocators);
    ruleType ??= normalizeRuleType(
      (source as { getRuleType: (deps: RuleTypeModuleDeps) => UntypedRuleType }).getRuleType({
        logger: host.logger,
        isServerless: host.server.isServerless,
        kibanaVersion: host.server.version,
        publicBaseUrl: host.server.publicBaseUrl,
        settings: host.settings ?? {},
        locators: urlService.locators,
        host: host as TaskHost,
        runtime: services.runtime as RuleRunRuntime,
        fieldFormats: services.fieldFormats as FieldFormatsStart,
      }),
      { config: host.settings!.alerting as AlertingConfig, logger: host.logger }
    );
    if (ruleType.id !== id) {
      throw new Error(`Module declares rule type "${id}" but its factory built "${ruleType.id}"`);
    }
    return ruleType;
  };
  let prepared: Promise<PreparedRuleRun> | undefined;

  const prepare = (host: TaskHost): Promise<PreparedRuleRun> =>
    (prepared ??= options.getRuntime
      ? options.getRuntime().then((runtime): PreparedRuleRun => ({ runtime }))
      : import('./standalone/create_standalone_rule_run_runtime').then(
          ({ createStandaloneRuleRunRuntime }) => {
            urlService ??= createUrlService(host, options.locators, options.registerLocators);
            // The runtime first, so the factory of the rule type can build its services from it.
            const standalone = createStandaloneRuleRunRuntime({
              host,
              executeConnectors: options.executeConnectors,
              getRuleType: () => ruleType!,
              urlService,
              connectorAdapters: options.connectorAdapters,
              contributions,
            });
            buildRuleType(host, {
              runtime: standalone.runtime,
              fieldFormats: standalone.fieldFormats as never,
            });
            if (ruleType!.alerts) {
              standalone.runtime.alertsService?.register(ruleType!.alerts as never);
            }
            return {
              runtime: standalone.runtime,
              unsupportedActionTypes: standalone.getUnsupportedActionTypes,
              connectorTypeIds: standalone.getRegisteredConnectorTypeIds,
              connectorAdapterIds: standalone.getRegisteredConnectorAdapterIds,
            };
          }
        ));

  /**
   * A rule that uses a connector type or connector adapter this process does not know cannot be
   * served here; saying so before anything is written lets Kibana run the rule instead. This is the
   * check of one rule; `parity` below is the check, once per process, of everything Kibana has.
   */
  const declineIfUnsupported = async (
    { runtime, unsupportedActionTypes }: PreparedRuleRun,
    context: RunContext,
    host: TaskHost
  ) => {
    if (!unsupportedActionTypes && !options.declineRun) return;
    const { alertId, spaceId } = context.taskInstance.params as {
      alertId: string;
      spaceId: string;
    };
    let actionTypeIds: string[] = [];
    let ruleParams: Record<string, unknown> = {};
    try {
      const rule = await runtime.savedObjects
        .createInternalRepository([RULE_SAVED_OBJECT_TYPE])
        .get<{ actions?: Array<{ actionTypeId?: string }>; params?: Record<string, unknown> }>(
          RULE_SAVED_OBJECT_TYPE,
          alertId,
          { namespace: runtime.spaceIdToNamespace(spaceId) }
        );
      actionTypeIds = [
        ...new Set(
          (rule.attributes.actions ?? []).flatMap((a) => (a.actionTypeId ? [a.actionTypeId] : []))
        ),
      ];
      ruleParams = rule.attributes.params ?? {};
    } catch (error) {
      // A rule that cannot be read is reported by the run itself.
      return;
    }
    const reason = options.declineRun?.({ settings: host.settings ?? {}, ruleParams });
    if (reason) {
      throw new DeclinedRunError(`Rule ${alertId} cannot run in this task process: ${reason}`);
    }
    const unsupported = unsupportedActionTypes?.(actionTypeIds) ?? [];
    if (unsupported.length) {
      throw new DeclinedRunError(
        `Rule ${alertId} uses action types this task process cannot enqueue: ${unsupported.join(
          ', '
        )}`
      );
    }
  };

  const taskType = defineTaskType({
    type: `alerting:${id}`,
    ...(kibanaRuleType
      ? {
          title: kibanaRuleType.name,
          priority: kibanaRuleType.priority,
          timeout: kibanaRuleType.ruleTaskTimeout,
          ...(cost ? { cost } : {}),
        }
      : {}),
    stateSchemaByVersion,
    // When a task process serves the run, Kibana still counts it for the `node_rules` usage collector.
    ...(kibanaRuleType && options.getRuntime
      ? {
          observeRemoteRun: () =>
            observeRemoteRuleRun(async () => (await options.getRuntime!()).inMemoryMetrics),
        }
      : {}),
    // Every rule run enqueues actions as its user: the privileges of the connector are checked by the
    // security plugin's own authorization, so the process always has it (and Core's security delegate).
    // Every rule run may report analytics events, which the process ships itself before it answers.
    taskPlugins: [
      ...(options.taskPlugins ?? []).filter(
        ({ manifest }) => manifest.id !== 'security' && manifest.id !== 'telemetry'
      ),
      createSecurityTaskPlugin(kibanaPackageJson.version),
      createTelemetryTaskPlugin(kibanaPackageJson.version),
    ],
    taskTypeGroup: TaskTypeGroup.Alerting,
    paramsSchema: ruleTaskParamsSchema,
    // What a task process needs; Kibana has all of it already, so only the process's module says so.
    ...(kibanaRuleType
      ? {}
      : {
          eventLog: {
            providers: [
              { provider: EVENT_LOG_PROVIDER, actions: Object.values(EVENT_LOG_ACTIONS) },
              ...(options.executeConnectors
                ? [
                    {
                      provider: ACTIONS_EVENT_LOG_PROVIDER,
                      actions: Object.values(ACTIONS_EVENT_LOG_ACTIONS),
                    },
                  ]
                : []),
              ...(options.eventLogProviders ?? []),
            ],
            create: createStandaloneEventLog,
          },
          taskManager: { schedulableTypes: [/^actions:/, ...(options.schedulableTaskTypes ?? [])] },
          licensing: true as const,
          usageCounters: true as const,
          settings: [
            ...new Set([
              'alerting',
              'actions',
              'security',
              ALERTING_RUN_SETTINGS_ID,
              ...(options.settings ?? []),
            ]),
          ],
          optionalSettings: options.optionalSettings,
          // Kibana sends the connector types and adapters it registered; the process must have
          // registered the same, or it declines the run: a rule would otherwise behave differently.
          parity: [
            {
              kind: CONNECTOR_TYPES_PARITY_KIND,
              getIds: async (host: TaskHost) => (await prepare(host)).connectorTypeIds?.() ?? [],
            },
            {
              kind: CONNECTOR_ADAPTERS_PARITY_KIND,
              getIds: async (host: TaskHost) => (await prepare(host)).connectorAdapterIds?.() ?? [],
            },
          ],
        }),
    createTaskRunner: (context, host): CancellableTask => {
      const runner = prepare(host).then(async (services) => {
        await declineIfUnsupported(services, context, host);
        const { runtime } = services;
        return new TaskRunner({
          context: runtime,
          inMemoryMetrics: runtime.inMemoryMetrics,
          internalSavedObjectsRepository: runtime.savedObjects.createInternalRepository([
            RULE_SAVED_OBJECT_TYPE,
          ]),
          ruleType: ruleType!,
          taskInstance: context.taskInstance as never,
          executionUuid: context.executionUuid,
        });
      });
      return {
        run: async () => (await runner).run(),
        cancel: async () => (await runner).cancel(),
      };
    },
  });
  if (!kibanaRuleType) {
    // The saved object types and ui settings are built from the code of other plugins, which costs
    // something, so only when a task process reads them.
    let declarations: ReturnType<typeof getRuleRunDeclarations> | undefined;
    const getDeclarations = () => (declarations ??= getRuleRunDeclarations());
    Object.defineProperties(taskType, {
      savedObjectTypes: {
        enumerable: true,
        get: () => [
          ...getDeclarations().savedObjectTypes,
          ...(options.savedObjectTypes ?? []),
          ...contributions.flatMap((contribution) => contribution.declares?.savedObjectTypes ?? []),
        ],
      },
      encryptedSavedObjectTypes: {
        enumerable: true,
        get: () => [
          ...getDeclarations().encryptedSavedObjectTypes,
          ...(options.encryptedSavedObjectTypes ?? []),
          ...contributions.flatMap(
            (contribution) => contribution.declares?.encryptedSavedObjectTypes ?? []
          ),
        ],
      },
      uiSettings: {
        enumerable: true,
        get: () => ({ defaults: [...getRuleRunUiSettings(), ...(options.uiSettings ?? [])] }),
      },
      // The flags the contributions read (the opt-ins of `alert.status.changed`, say), which Kibana
      // evaluates for each dispatch.
      featureFlags: {
        enumerable: true,
        configurable: true,
        get: () => {
          const flags = Object.assign(
            {},
            ...contributions.map((contribution) => contribution.declares?.featureFlags)
          ) as Record<string, boolean | string | number>;
          return Object.keys(flags).length ? flags : undefined;
        },
      },
      analyticsEventTypes: {
        enumerable: true,
        get: () => [
          // What the connectors a rule executes itself (such as a model's) report.
          ...(options.executeConnectors ? actionsEventTypes : []),
          ...(options.analyticsEventTypes ?? []),
        ],
      },
    });
  }
  if (!kibanaRuleType) {
    Object.assign(taskType, {
      // A task process hands over what plugins contribute; the module is built again with it.
      contributions: {
        keys: [RULE_RUN_CONTRIBUTIONS],
        apply: (contributed: Record<string, unknown[]>) =>
          createRuleTaskType(
            source,
            options,
            (contributed[RULE_RUN_CONTRIBUTIONS] ?? []) as RuleRunContribution[]
          ),
      },
    });
  }
  return Object.assign(taskType, { buildRuleType });
}
