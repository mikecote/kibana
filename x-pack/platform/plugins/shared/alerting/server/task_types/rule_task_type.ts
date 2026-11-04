/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { Logger } from '@kbn/core/server';
import { stateSchemaByVersion } from '@kbn/alerting-state-types';
import {
  DeclinedRunError,
  defineTaskType,
  type RunContext,
  type TaskHost,
  type TaskTypeModule,
} from '@kbn/task-manager-plugin/server';
import { TaskTypeGroup } from '@kbn/task-manager-plugin/server/task';
import type { CancellableTask } from '@kbn/task-manager-plugin/server/task';
import { createStandaloneEventLog } from '@kbn/event-log-plugin/server/standalone_event_log';
import type { LocatorDefinition } from '@kbn/share-plugin/common/url_service';
import type { RuleRunActionsSetup } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import type { ConnectorAdapter } from '../connector_adapters/types';
import type { AlertingConfig } from '../config';
import { EVENT_LOG_ACTIONS, EVENT_LOG_PROVIDER } from '../constants/event_log';
import { normalizeRuleType, RULE_TYPES_WITH_CUSTOM_COST } from '../lib/normalize_rule_type';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import { RULE_SAVED_OBJECT_TYPE } from '../saved_objects';
import { TaskRunner } from '../task_runner/task_runner';
import type { RuleRunRuntime } from '../task_runner/types';
import type { UntypedRuleType } from '../types';
import { getRuleRunDeclarations } from './rule_run_saved_object_types';
import { getRuleRunUiSettings } from './rule_run_ui_settings';

export const ruleTaskParamsSchema = schema.object({
  alertId: schema.string(),
  spaceId: schema.string(),
  consumer: schema.maybe(schema.string()),
});

/** What the factory of a rule type may use when a task process builds it: the host, nothing else. */
export interface RuleTypeModuleDeps {
  logger: Logger;
  isServerless: boolean;
  kibanaVersion: string;
  publicBaseUrl?: string;
  /** The validated configs of the plugins the module lists, such as `settings.alerting`. */
  settings: Record<string, unknown>;
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
  /** A task process only: the connector adapters rules of this rule type may use. */
  connectorAdapters?: ConnectorAdapter[];
  /** A task process only: registers the connector types rules of this rule type may enqueue. */
  registerConnectorTypes?: (
    actions: RuleRunActionsSetup,
    context: { publicBaseUrl?: string }
  ) => void;
}

export type RuleTypeSource =
  /** Kibana: the rule type as `RuleTypeRegistry` keeps it. */
  | { ruleType: UntypedNormalizedRuleType }
  /** A task process: how to build the rule type from the host, and its id without building it. */
  | { ruleTypeId: string; getRuleType: (deps: RuleTypeModuleDeps) => UntypedRuleType };

const hostDeps = (host: TaskHost): RuleTypeModuleDeps => ({
  logger: host.logger,
  isServerless: host.server.isServerless,
  kibanaVersion: host.server.version,
  publicBaseUrl: host.server.publicBaseUrl,
  settings: host.settings ?? {},
});

/**
 * The task type of a rule type, `alerting:<id>`, as a task type module. Kibana builds it from the
 * registered rule type and runs it with the alerting plugin's own services. A task process builds it
 * from the rule type factory of the plugin that owns the rule type, with services built from the
 * host, and runs the same `TaskRunner`.
 */
export function createRuleTaskType(
  source: RuleTypeSource,
  options: RuleTaskTypeOptions = {}
): TaskTypeModule {
  const kibanaRuleType = 'ruleType' in source ? source.ruleType : undefined;
  const id = kibanaRuleType ? kibanaRuleType.id : (source as { ruleTypeId: string }).ruleTypeId;
  const cost = RULE_TYPES_WITH_CUSTOM_COST[id];

  let ruleType: UntypedNormalizedRuleType | undefined = kibanaRuleType;
  let prepared:
    | Promise<{ runtime: RuleRunRuntime; unsupportedActionTypes?: (ids: string[]) => string[] }>
    | undefined;

  const prepare = (host: TaskHost) => {
    ruleType ??= normalizeRuleType(
      (source as { getRuleType: Function }).getRuleType(hostDeps(host)),
      {
        config: host.settings!.alerting as AlertingConfig,
        logger: host.logger,
      }
    );
    if (ruleType.id !== id) {
      throw new Error(`Module declares rule type "${id}" but its factory built "${ruleType.id}"`);
    }
    return (prepared ??= options.getRuntime
      ? options.getRuntime().then((runtime) => ({ runtime }))
      : import('./standalone/create_standalone_rule_run_runtime').then(
          ({ createStandaloneRuleRunRuntime }) => {
            const standalone = createStandaloneRuleRunRuntime({
              host,
              ruleType: ruleType!,
              locators: options.locators,
              connectorAdapters: options.connectorAdapters,
              registerConnectorTypes: options.registerConnectorTypes,
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

  return defineTaskType({
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
          ...getRuleRunDeclarations(),
          eventLog: {
            providers: [
              { provider: EVENT_LOG_PROVIDER, actions: Object.values(EVENT_LOG_ACTIONS) },
            ],
            create: createStandaloneEventLog,
          },
          taskManager: true as const,
          uiSettings: { defaults: getRuleRunUiSettings() },
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
}
