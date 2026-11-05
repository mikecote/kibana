/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, SavedObjectsType } from '@kbn/core/server';
import { stateSchemaByVersion } from '@kbn/alerting-state-types';
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
}

export type RuleTypeSource =
  /** Kibana: the rule type as `RuleTypeRegistry` keeps it. */
  | { ruleType: UntypedNormalizedRuleType }
  /** A task process: how to build the rule type from the host, and its id without building it. */
  | { ruleTypeId: string; getRuleType: (deps: RuleTypeModuleDeps) => UntypedRuleType };

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
  const buildRuleType = (host: HostForRuleType) => {
    urlService ??= createUrlService(host, options.locators, options.registerLocators);
    ruleType ??= normalizeRuleType(
      (source as { getRuleType: (deps: RuleTypeModuleDeps) => UntypedRuleType }).getRuleType({
        logger: host.logger,
        isServerless: host.server.isServerless,
        kibanaVersion: host.server.version,
        publicBaseUrl: host.server.publicBaseUrl,
        settings: host.settings ?? {},
        locators: urlService.locators,
      }),
      { config: host.settings!.alerting as AlertingConfig, logger: host.logger }
    );
    if (ruleType.id !== id) {
      throw new Error(`Module declares rule type "${id}" but its factory built "${ruleType.id}"`);
    }
    return ruleType;
  };
  let prepared:
    | Promise<{ runtime: RuleRunRuntime; unsupportedActionTypes?: (ids: string[]) => string[] }>
    | undefined;

  const prepare = (host: TaskHost) => {
    if (!kibanaRuleType) buildRuleType(host);
    return (prepared ??= options.getRuntime
      ? options.getRuntime().then((runtime) => ({ runtime }))
      : import('./standalone/create_standalone_rule_run_runtime').then(
          ({ createStandaloneRuleRunRuntime }) => {
            const standalone = createStandaloneRuleRunRuntime({
              host,
              ruleType: ruleType!,
              urlService: urlService!,
              connectorAdapters: options.connectorAdapters,
              contributions,
            });
            return {
              runtime: standalone.runtime,
              unsupportedActionTypes: standalone.getUnsupportedActionTypes,
            };
          }
        ));
  };

  /**
   * A rule that uses a connector type or connector adapter this process does not know cannot be
   * served here; saying so before anything is written lets Kibana run the rule instead.
   */
  const declineIfUnsupported = async (
    { runtime, unsupportedActionTypes }: Awaited<NonNullable<typeof prepared>>,
    context: RunContext
  ) => {
    if (!unsupportedActionTypes) return;
    const { alertId, spaceId } = context.taskInstance.params as {
      alertId: string;
      spaceId: string;
    };
    let actionTypeIds: string[] = [];
    try {
      const rule = await runtime.savedObjects
        .createInternalRepository([RULE_SAVED_OBJECT_TYPE])
        .get<{ actions?: Array<{ actionTypeId?: string }> }>(RULE_SAVED_OBJECT_TYPE, alertId, {
          namespace: runtime.spaceIdToNamespace(spaceId),
        });
      actionTypeIds = [
        ...new Set(
          (rule.attributes.actions ?? []).flatMap((a) => (a.actionTypeId ? [a.actionTypeId] : []))
        ),
      ];
    } catch (error) {
      // A rule that cannot be read is reported by the run itself.
      return;
    }
    const unsupported = unsupportedActionTypes(actionTypeIds);
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
    taskTypeGroup: TaskTypeGroup.Alerting,
    paramsSchema: ruleTaskParamsSchema,
    // What a task process needs; Kibana has all of it already, so only the process's module says so.
    ...(kibanaRuleType
      ? {}
      : {
          eventLog: {
            providers: [
              { provider: EVENT_LOG_PROVIDER, actions: Object.values(EVENT_LOG_ACTIONS) },
            ],
            create: createStandaloneEventLog,
          },
          taskManager: true as const,
          licensing: true as const,
          settings: ['alerting', 'actions'],
        }),
    createTaskRunner: (context, host): CancellableTask => {
      const runner = prepare(host).then(async (services) => {
        await declineIfUnsupported(services, context);
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
          ...contributions.flatMap(
            (contribution) => contribution.declares?.encryptedSavedObjectTypes ?? []
          ),
        ],
      },
      uiSettings: {
        enumerable: true,
        get: () => ({ defaults: getRuleRunUiSettings() }),
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
