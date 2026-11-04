/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of, Subject } from 'rxjs';
import type { Logger, SavedObjectsServiceStart, SecurityServiceStart } from '@kbn/core/server';
import type { UiSettingsServiceStart } from '@kbn/core/server';
import { SavedObjectsUtils } from '@kbn/core-saved-objects-utils-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server';
import type { SharePluginStart } from '@kbn/share-plugin/server';
import { UrlService } from '@kbn/share-plugin/common/url_service';
import type { LocatorDefinition } from '@kbn/share-plugin/common/url_service';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import { DateFormat, DateNanosFormat } from '@kbn/field-formats-plugin/server/lib/converters';
import { baseFormatters } from '@kbn/field-formats-plugin/common';
import { createFieldFormatServiceFactory } from '@kbn/field-formats-plugin/server/field_format_service_factory';
import { dataViewsServiceFactory } from '@kbn/data-views-plugin/server/data_views_service_factory';
import { createStandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import { MaintenanceWindowClientFactory } from '@kbn/maintenance-windows-plugin/server/maintenance_window_client_factory';
import {
  createRuleRunActions,
  type RuleRunActionsSetup,
} from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import type { ActionsConfig } from '@kbn/actions-plugin/server/config';
import { AlertsService } from '../../alerts_service/alerts_service';
import { getDataStreamAdapter } from '../../alerts_service/lib/data_stream_adapter';
import type { AlertingConfig } from '../../config';
import { ConnectorAdapterRegistry } from '../../connector_adapters/connector_adapter_registry';
import type { ConnectorAdapter } from '../../connector_adapters/types';
import { EVENT_LOG_PROVIDER } from '../../constants/event_log';
import { getActionsConfigMap } from '../../lib/get_actions_config_map';
import { LicenseState } from '../../lib/license_state';
import { InMemoryMetrics } from '../../monitoring/in_memory_metrics';
import { RulesSettingsClientFactory } from '../../rules_settings/rules_settings_client_factory';
import { RulesSettingsService } from '../../rules_settings/rules_settings_service';
import { RULE_SAVED_OBJECT_TYPE } from '../../saved_objects';
import { MaintenanceWindowsService } from '../../task_runner/maintenance_windows/maintenance_windows_service';
import type { RuleRunRuntime } from '../../task_runner/types';
import { ApiKeyType } from '../../task_runner/types';
import type { UntypedNormalizedRuleType } from '../../rule_type_registry';
import type { IRuleTypeAlerts } from '../../types';
import { createSingleRuleTypeRegistry } from './single_rule_type_registry';

export interface StandaloneRuleRunOptions {
  host: TaskHost;
  ruleType: UntypedNormalizedRuleType;
  /** The locators the rule type's executor reads from `services.share.url.locators`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locators?: Array<LocatorDefinition<any>>;
  /** The connector adapters that rules of this rule type may use through system actions. */
  connectorAdapters?: ConnectorAdapter[];
  /** Registers the connector types a rule of this rule type may enqueue; see stack_connectors. */
  registerConnectorTypes?: (
    actions: RuleRunActionsSetup,
    context: { publicBaseUrl?: string }
  ) => void;
}

const spaceIdToNamespace = (spaceId?: string) =>
  spaceId ? SavedObjectsUtils.namespaceStringToId(spaceId) : undefined;

/**
 * The services of a rule run, built from the task host instead of the alerting plugin and the
 * plugins it uses. Everything is the plugin's own class over the host's services, except what
 * cannot exist in a process, which is `undefined` here and listed in the task types README: usage
 * counters, the `alert.status.changed` event bus, and the backfill and event log read clients.
 */
export const createStandaloneRuleRunRuntime = ({
  host,
  ruleType,
  locators = [],
  connectorAdapters = [],
  registerConnectorTypes = () => undefined,
}: StandaloneRuleRunOptions): {
  runtime: RuleRunRuntime;
  /** The action types a rule would use that this process cannot enqueue. */
  getUnsupportedActionTypes: (actionTypeIds: string[]) => string[];
  stop: () => void;
} => {
  const settings = host.settings ?? {};
  const config = settings.alerting as AlertingConfig;
  const actionsConfig = settings.actions as ActionsConfig;
  const logger: Logger = host.logger.get('plugins', 'alerting');
  const { isServerless, publicBaseUrl, version: kibanaVersion, uuid: serverUuid } = host.server;
  const savedObjects = host.savedObjects;
  const uiSettings = host.uiSettings as UiSettingsServiceStart;

  const licenseState = new LicenseState(host.licensing!.license$);

  const rulesSettingsClientFactory = new RulesSettingsClientFactory();
  rulesSettingsClientFactory.initialize({
    logger,
    savedObjectsService: savedObjects as SavedObjectsServiceStart,
    securityService: host.security as SecurityServiceStart,
    isServerless,
  });
  const rulesSettingsService = new RulesSettingsService({
    cacheInterval: config.rulesSettings.cacheInterval,
    getRulesSettingsClientWithRequest: (request) => rulesSettingsClientFactory.create(request),
    isServerless,
    logger,
  });

  const maintenanceWindowClientFactory = new MaintenanceWindowClientFactory();
  maintenanceWindowClientFactory.initialize({
    logger,
    savedObjectsService: savedObjects as SavedObjectsServiceStart,
    securityService: host.security as SecurityServiceStart,
    uiSettings,
  });
  const maintenanceWindowsService = new MaintenanceWindowsService({
    cacheInterval: config.rulesSettings.cacheInterval,
    logger,
    getMaintenanceWindowClient: (request) =>
      maintenanceWindowClientFactory.createWithoutAuthorization(request),
  });

  // Kibana installs the alerts resources and keeps them up to date; the process only needs the
  // service to hand out an alerts client once they exist. No cross-node lock: one process serves
  // one run, and installing a resource is idempotent.
  const alertsService = config.enableFrameworkAlerts
    ? new AlertsService({
        logger,
        pluginStop$: new Subject<void>(),
        kibanaVersion,
        serverUuid,
        dataStreamAdapter: getDataStreamAdapter({ useDataStreamForAlerts: isServerless }),
        elasticsearchClientPromise: Promise.resolve(host.elasticsearch.asInternalUser),
        elasticsearchAndSOAvailability$: of(true),
        isServerless,
        totalFieldsLimit: config.alertsService.totalFieldsLimit,
      })
    : null;
  if (alertsService && ruleType.alerts) alertsService.register(ruleType.alerts as IRuleTypeAlerts);

  const connectorAdapterRegistry = new ConnectorAdapterRegistry();
  connectorAdapters.forEach((adapter) => connectorAdapterRegistry.register(adapter));

  const { actionsPlugin, hasActionType, stop } = createRuleRunActions({
    logger: host.logger.get('plugins', 'actions'),
    config: actionsConfig,
    license$: host.licensing!.license$,
    elasticsearch: host.elasticsearch,
    savedObjects,
    getEncryptedSavedObjectsClient: host.encryptedSavedObjects!.getClient,
    taskManager: host.taskManager!,
    publicBaseUrl,
    registerConnectorTypes,
  });

  const fieldFormats = {
    fieldFormatServiceFactory: createFieldFormatServiceFactory([
      DateFormat,
      DateNanosFormat,
      ...baseFormatters,
    ]),
  };
  const dataViews = {
    dataViewsServiceFactory: dataViewsServiceFactory({
      logger,
      uiSettings,
      fieldFormats,
      capabilities: {} as never,
      scriptedFieldsEnabled: true,
      rollupsEnabled: false,
    }),
  };
  const data = {
    search: createStandaloneSearch({
      logger,
      elasticsearch: { client: host.elasticsearch },
      savedObjects,
      uiSettings,
      dataViews: dataViews as never,
      fieldFormats,
      isServerless,
    }),
  };

  const urlService = new UrlService({
    baseUrl: publicBaseUrl ?? '',
    version: kibanaVersion,
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

  const runtime: RuleRunRuntime = {
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
    ruleTypeRegistry: createSingleRuleTypeRegistry(ruleType, licenseState),
    rulesSettingsService,
    apiKeyType: (config.rules.apiKeyType as ApiKeyType) ?? ApiKeyType.ES,
    savedObjects,
    share: { url: urlService } as unknown as SharePluginStart,
    spaceIdToNamespace,
    uiSettings,
    isServerless,
    // A process has no UIAM key to grant: see the task types README.
    shouldGrantUiam: false,
  };

  return {
    runtime,
    getUnsupportedActionTypes: (actionTypeIds) =>
      actionTypeIds.filter((id) => !hasActionType(id) && !connectorAdapterRegistry.has(id)),
    stop: () => {
      stop();
      licenseState.clean();
    },
  };
};
