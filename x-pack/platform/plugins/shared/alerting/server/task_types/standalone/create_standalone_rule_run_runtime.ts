/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import { AsyncLocalStorage } from 'async_hooks';
import type { Logger } from '@kbn/core/server';
import type { UiSettingsServiceStart } from '@kbn/core/server';
import { SavedObjectsUtils } from '@kbn/core-saved-objects-utils-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server';
import type { SharePluginStart } from '@kbn/share-plugin/server';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import { createStandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import { MaintenanceWindowClientFactory } from '@kbn/maintenance-windows-plugin/server/maintenance_window_client_factory';
import type { UsageCounter } from '@kbn/usage-collection-plugin/server';
import { ACTIONS_FEATURE_ID } from '@kbn/actions-plugin/common';
import { createRuleRunActions } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import { EVENT_LOG_PROVIDER as ACTIONS_EVENT_LOG_PROVIDER } from '@kbn/actions-plugin/server/constants/event_log';
import {
  ACTIONS_CONNECTORS_SETTINGS_ID,
  type ActionsTaskProcessSettings,
} from '@kbn/actions-plugin/server/task_types/task_process_settings';
import type { ActionsConfig } from '@kbn/actions-plugin/server/config';
import { createTaskProcessAlertsService } from './create_task_process_alerts_service';
import type { AlertingConfig } from '../../config';
import { ConnectorAdapterRegistry } from '../../connector_adapters/connector_adapter_registry';
import type { ConnectorAdapter } from '../../connector_adapters/types';
import { EVENT_LOG_PROVIDER } from '../../constants/event_log';
import { getActionsConfigMap } from '../../lib/get_actions_config_map';
import { LicenseState } from '../../lib/license_state';
import type { AlertStatusChangedOptIn } from '../../lib/workflow_extensions/alert_status_changed_opt_in';
import { createWorkflowsAlertStatusChangedEmitter } from '../../lib/workflow_extensions/alert_status_changed_emitter';
import { InMemoryMetrics } from '../../monitoring/in_memory_metrics';
import { RulesSettingsClientFactory } from '../../rules_settings/rules_settings_client_factory';
import { RulesSettingsService } from '../../rules_settings/rules_settings_service';
import { RULE_SAVED_OBJECT_TYPE } from '../../saved_objects';
import { MaintenanceWindowsService } from '../../task_runner/maintenance_windows/maintenance_windows_service';
import { ALERTING_FEATURE_ID } from '../../types';
import type { RuleRunRuntime } from '../../task_runner/types';
import { ApiKeyType } from '../../task_runner/types';
import type { UntypedNormalizedRuleType } from '../../rule_type_registry';
import type {
  RuleExecutionServices,
  RuleRunContribution,
  RuleRunContributionContext,
} from '../rule_run_contribution';
import { ALERTING_RUN_SETTINGS_ID, DEFAULT_ALERTING_RUN_SETTINGS } from '../rule_run_settings';
import type { AlertingRunSettings } from '../rule_run_settings';
import { createSingleRuleTypeRegistry } from './single_rule_type_registry';
import { createStandaloneFieldFormats } from './field_formats';
import { createRuleDataViews } from './create_rule_data_views';

export interface StandaloneRuleRunOptions {
  host: TaskHost;
  /** The rule type this runtime serves, once its factory has built it: a run reads it, building does not. */
  getRuleType: () => UntypedNormalizedRuleType;
  /** The locators the rule type's executor reads from `services.share.url.locators`. */
  /** The URL service the rule type was built with, so executors read the same locators. */
  urlService: SharePluginStart['url'];
  /** The connector adapters that rules of this rule type may use through system actions. */
  connectorAdapters?: ConnectorAdapter[];
  /** What other plugins add to a rule run: connector types and adapters of system actions. */
  contributions?: RuleRunContribution[];
  /** The rule type executes connectors in the process, so the actions executor is initialized. */
  executeConnectors?: boolean;
}

const spaceIdToNamespace = (spaceId?: string) =>
  spaceId ? SavedObjectsUtils.namespaceStringToId(spaceId) : undefined;

/**
 * The services of a rule run, built from the task host instead of the alerting plugin and the
 * plugins it uses. Everything is the plugin's own class over the host's services, except what
 * cannot exist in a process, which is `undefined` here and listed in the task types README: the
 * backfill and event log read clients. `alert.status.changed` events go out through the workflows
 * client a contribution provides (`getWorkflowsClient`), and nothing without one.
 */
export const createStandaloneRuleRunRuntime = ({
  host,
  getRuleType,
  urlService,
  connectorAdapters = [],
  contributions = [],
  executeConnectors = false,
}: StandaloneRuleRunOptions): {
  runtime: RuleRunRuntime;
  /** The field formats the runtime was built with, for rule types that format values. */
  fieldFormats: ReturnType<typeof createStandaloneFieldFormats>;
  /** The action types a rule would use that this process cannot enqueue. */
  getUnsupportedActionTypes: (actionTypeIds: string[]) => string[];
  /** The ids of the connector types and connector adapters this process registered. */
  getRegisteredConnectorTypeIds: () => string[];
  getRegisteredConnectorAdapterIds: () => string[];
  runWithServices: <T>(run: () => Promise<T>) => Promise<T>;
  stop: () => Promise<void>;
} => {
  const settings = host.settings ?? {};
  const config = settings.alerting as AlertingConfig;
  const actionsConfig = settings.actions as ActionsConfig;
  const logger: Logger = host.logger.get('plugins', 'alerting');
  const { isServerless, publicBaseUrl, version: kibanaVersion } = host.server;
  const savedObjects = host.savedObjects;
  const uiSettings = host.uiSettings as UiSettingsServiceStart;

  const licenseState = new LicenseState(host.licensing!.license$);
  // As in Kibana, a rule type that needs a license reports its use, to the store every node shares.
  if (host.licensing!.featureUsage) {
    licenseState.setNotifyUsage(host.licensing!.featureUsage.notifyUsage);
  }

  // The counters of the domains Kibana counts rule runs under, stored when the run ends.
  const usageCounter = host.usageCounters?.getUsageCounter(ALERTING_FEATURE_ID) as
    | UsageCounter
    | undefined;
  const actionsUsageCounter = host.usageCounters?.getUsageCounter(ACTIONS_FEATURE_ID);

  const rulesSettingsClientFactory = new RulesSettingsClientFactory();
  rulesSettingsClientFactory.initialize({
    logger,
    savedObjectsService: savedObjects,
    securityService: host.security,
    isServerless,
  });
  const rulesSettingsService = new RulesSettingsService({
    cacheInterval: config.rulesSettings.cacheInterval,
    getRulesSettingsClientWithRequest: (request) => rulesSettingsClientFactory.create(request),
    isServerless,
    logger,
  });

  // What Kibana decided while it started from the plugins around alerting.
  const runSettings =
    (settings[ALERTING_RUN_SETTINGS_ID] as AlertingRunSettings | undefined) ??
    DEFAULT_ALERTING_RUN_SETTINGS;

  const maintenanceWindowClientFactory = new MaintenanceWindowClientFactory();
  maintenanceWindowClientFactory.initialize({
    logger,
    savedObjectsService: savedObjects,
    securityService: host.security,
    uiSettings,
  });
  const maintenanceWindowsService = new MaintenanceWindowsService({
    cacheInterval: config.rulesSettings.cacheInterval,
    logger,
    // As in Kibana: without the maintenance windows plugin no window applies to a run.
    getMaintenanceWindowClient: (request) =>
      runSettings.maintenanceWindowsEnabled
        ? maintenanceWindowClientFactory.createWithoutAuthorization(request)
        : undefined,
  });

  // Kibana installs the alerts resources and keeps them up to date; the process only needs the
  // service to hand out an alerts client once they exist. No cross-node lock: one process serves
  // one run, and installing a resource is idempotent.
  const alertsService = createTaskProcessAlertsService(host, config, logger);

  const connectorAdapterRegistry = new ConnectorAdapterRegistry();
  connectorAdapters.forEach((adapter) => connectorAdapterRegistry.register(adapter));

  // Kibana's connectors as it has them now, not rebuilt from the config.
  const sentConnectors = settings[ACTIONS_CONNECTORS_SETTINGS_ID] as
    | ActionsTaskProcessSettings
    | undefined;
  // The opt-ins of `alert.status.changed` the contributions register, as plugins do in Kibana.
  const alertStatusChangedOptIns: AlertStatusChangedOptIn[] = [];
  const executionServices = new AsyncLocalStorage<Map<string, RuleExecutionServices>>();
  const contributionContext: RuleRunContributionContext = {
    logger,
    isServerless,
    kibanaVersion,
    publicBaseUrl,
    settings,
    host,
    getService: <T extends object>(id: string): T => {
      const services = executionServices.getStore()?.get(id);
      if (!services) throw new Error(`No rule execution service registered for ${id}`);
      return services.getService<T>(id);
    },
  };
  const { actionsPlugin, hasActionType, getActionTypeIds, stop } = createRuleRunActions({
    logger: host.logger.get('plugins', 'actions'),
    config: actionsConfig,
    inMemoryConnectors: sentConnectors?.inMemoryConnectors,
    license$: host.licensing!.license$,
    usageCounter: actionsUsageCounter,
    featureUsage: host.licensing!.featureUsage,
    elasticsearch: host.elasticsearch,
    savedObjects,
    getEncryptedSavedObjectsClient: host.encryptedSavedObjects!.getClient,
    taskManager: host.taskManager!,
    publicBaseUrl,
    authorization: (host.plugins?.security as { authz?: never } | undefined)?.authz,
    getAuditLoggerWithRequest: (request) => host.security.audit.asScoped(request),
    executor: executeConnectors
      ? {
          security: host.security,
          eventLogger: host.eventLog!.getLogger({
            event: { provider: ACTIONS_EVENT_LOG_PROVIDER },
          }) as IEventLogger,
          analyticsService: host.analytics as never,
          createInternalRepository: host.savedObjects.createInternalRepository,
        }
      : undefined,
    registerConnectorTypes: (actions) => {
      const registries = {
        actions,
        alerting: {
          registerConnectorAdapter: (adapter: unknown) =>
            connectorAdapterRegistry.register(adapter as ConnectorAdapter),
          enableAlertStatusChanged: (optIn: AlertStatusChangedOptIn) => {
            alertStatusChangedOptIns.push(optIn);
          },
        },
      };
      contributions.forEach((contribution) =>
        contribution.register?.(registries, contributionContext)
      );
    },
  });

  const fieldFormats = createStandaloneFieldFormats();
  const dataViews = createRuleDataViews(host, runSettings, fieldFormats);
  const data = {
    search: createStandaloneSearch({
      logger,
      elasticsearch: { client: host.elasticsearch },
      savedObjects,
      uiSettings,
      dataViews: dataViews as never,
      fieldFormats,
      isServerless,
      searchConfig: runSettings.search?.searchConfig,
      elasticsearchTimeouts: runSettings.search?.elasticsearchTimeouts,
      rollupsEnabled: runSettings.search?.rollupsEnabled,
      // ES|QL searches read the license to allow approximation, as they do in Kibana.
      licensing: { getLicense: () => firstValueFrom(host.licensing!.license$) as never },
    }),
  };

  // Events go out with the workflows client the workflows plugins contribute; without one nothing is sent.
  const workflowsContribution = contributions.find(
    ({ getWorkflowsClient, executionServices: provider }) =>
      getWorkflowsClient !== undefined && (!provider || provider.isEnabled(settings))
  );
  const alertStatusChanged = workflowsContribution
    ? createWorkflowsAlertStatusChangedEmitter({
        getClient: (request) =>
          workflowsContribution.getWorkflowsClient!(request, contributionContext),
        optIns: alertStatusChangedOptIns,
        logger,
      })
    : undefined;

  const runtime: RuleRunRuntime = {
    alertStatusChanged,
    actionsConfigMap: getActionsConfigMap(config.rules.run.actions),
    actionsPlugin,
    alertsService,
    auditService: host.security.audit as never,
    cancelAlertsOnRuleTimeout: config.cancelAlertsOnRuleTimeout,
    connectorAdapterRegistry,
    data,
    dataViews: dataViews as never,
    elasticsearch: { client: host.elasticsearch },
    encryptedSavedObjectsClient: host.encryptedSavedObjects!.getClient({
      includedHiddenTypes: [RULE_SAVED_OBJECT_TYPE],
    }),
    eventLogger: host.eventLog!.getLogger({
      event: { provider: EVENT_LOG_PROVIDER },
    }) as IEventLogger,
    executionContext: host.executionContext,
    inMemoryMetrics: new InMemoryMetrics(logger.get('in_memory_metrics')),
    kibanaBaseUrl: publicBaseUrl,
    logger,
    maintenanceWindowsService,
    maxAlerts: config.rules.run.alerts.max,
    ruleTypeRegistry: createSingleRuleTypeRegistry(getRuleType, licenseState),
    rulesSettingsService,
    apiKeyType: (config.rules.apiKeyType as ApiKeyType) ?? ApiKeyType.ES,
    savedObjects,
    share: { url: urlService },
    spaceIdToNamespace,
    uiSettings,
    usageCounter,
    isServerless,
    // As in Kibana: UIAM API keys are used when Core's security exposes them (serverless with UIAM).
    shouldGrantUiam: !!host.security.authc.apiKeys.uiam,
  };

  return {
    runtime,
    runWithServices: (run) =>
      executionServices.run(new Map(), async () => {
        const services = executionServices.getStore();
        if (!services) throw new Error('Rule execution service context is missing');
        const created: RuleExecutionServices[] = [];
        const outcome = await (async () => {
          try {
            for (const contribution of contributions) {
              const provider = contribution.executionServices;
              if (!provider?.isEnabled(settings)) continue;
              const instance = await provider.create(contributionContext);
              created.push(instance);
              for (const id of provider.ids) {
                if (services.has(id)) throw new Error(`Duplicate rule execution service: ${id}`);
                services.set(id, instance);
              }
            }
            return { failed: false as const, value: await run() };
          } catch (error) {
            return { failed: true as const, error };
          }
        })();
        const results = await Promise.allSettled(
          created.reverse().map((service) => Promise.resolve().then(() => service.stop()))
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected'
            ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
            : []
        );
        if (failures.length) {
          if (outcome.failed)
            failures.unshift(
              outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
            );
          throw new AggregateError(failures, 'Rule service cleanup failed');
        }
        if (outcome.failed) throw outcome.error;
        return outcome.value;
      }),
    fieldFormats,
    getRegisteredConnectorTypeIds: getActionTypeIds,
    getRegisteredConnectorAdapterIds: () => connectorAdapterRegistry.getIds(),
    getUnsupportedActionTypes: (actionTypeIds) =>
      actionTypeIds.filter((id) => !hasActionType(id) && !connectorAdapterRegistry.has(id)),
    stop: async () => {
      licenseState.clean();
      await stop();
    },
  };
};
