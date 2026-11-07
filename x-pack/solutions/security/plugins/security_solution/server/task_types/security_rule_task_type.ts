/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defer } from 'rxjs';
import { kibanaPackageJson } from '@kbn/repo-info';
import type { SavedObjectsType } from '@kbn/core/server';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type {
  RuleTaskTypeModule,
  RuleTypeModuleDeps,
} from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { UntypedRuleType } from '@kbn/alerting-plugin/server/types';
import type { ActionsConfig } from '@kbn/actions-plugin/server/config';
import { getActionsConfigurationUtilities } from '@kbn/actions-plugin/server/actions_config';
import type { IEventLogService } from '@kbn/event-log-plugin/server';
import { createSecurityTaskPlugin } from '@kbn/security-plugin/server/task_plugin';
import {
  getFleetRunEncryptedSavedObjectTypes,
  getFleetRunSavedObjectTypes,
} from '@kbn/fleet-plugin/server/services/run_time/saved_objects';
import { getOsqueryRunSavedObjectTypes } from '@kbn/osquery-plugin/server/run_time/saved_objects';
import { querySavedObjectType } from '@kbn/data-plugin/server/saved_objects/query';
import { createEntityStoreRunServices } from '@kbn/entity-store/server';
import {
  createListsTaskProcessServices,
  exceptionListAgnosticType,
  exceptionListType,
  LISTS_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/lists-plugin/server';
import {
  createRuleDataTaskProcessService,
  RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/rule-registry-plugin/server';
import type { AlertingConfig } from '@kbn/alerting-plugin/server/config';
import { FLEET_PACKAGE_METADATA_SETTINGS_ID } from '@kbn/fleet-plugin/server/package_metadata_task_process_settings';
import { RuleExecutionEventType } from '../../common/api/detection_engine/rule_monitoring';
import { APP_ID } from '../../common/constants';
import { TASK_PROCESS_SETTINGS_ID } from '../config';
import type { SecurityRuleRunConfig } from '../config';
import { getEndpointResponseActionsRunSavedObjectTypes } from '../endpoint/run_time/saved_objects';
import { createSecurityRuleRunServices } from '../lib/detection_engine/rule_types/create_security_rule_run_services';
import { createSecurityRuleTypeWrapper } from '../lib/detection_engine/rule_types/create_security_rule_type_wrapper';
import type { CreateSecurityRuleTypeWrapperProps } from '../lib/detection_engine/rule_types/types';
import { RULE_EXECUTION_LOG_PROVIDER } from '../lib/detection_engine/rule_monitoring/logic/event_log/event_log_constants';
import { createRuleExecutionLogClientForExecutorsFactory } from '../lib/detection_engine/rule_monitoring/logic/service';
import { createRuleRunTelemetrySender } from '../lib/telemetry/rule_run_events_sender';
import type { RuleRunTelemetrySender } from '../lib/telemetry/rule_run_events_sender';
import { events as securityEventTypes } from '../lib/telemetry/event_based/events';
import { getSecurityRuleRunUiSettings } from '../ui_settings';
import { getResponseActionsServices } from './response_actions_services';

/** The settings a detection rule needs besides the alerting ones: `lists` is optional, as the plugin is. */
const SETTINGS = [TASK_PROCESS_SETTINGS_ID, RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID];

/** What the executors of the detection rule types read, besides what every rule run reads. */
const SAVED_OBJECT_TYPES: SavedObjectsType[] = [
  exceptionListType,
  exceptionListAgnosticType,
  // The saved query of a saved query rule.
  querySavedObjectType,
  // The opt-in of the endpoint exceptions per policy, which every run reads, and what the endpoint
  // response actions read (the types of the script library are declared whatever the feature flag).
  ...getEndpointResponseActionsRunSavedObjectTypes({
    responseActionsScriptLibraryManagement: true,
  }),
  // What the response actions of Elastic Defend and Osquery read and write through Fleet.
  ...getFleetRunSavedObjectTypes(),
  ...getOsqueryRunSavedObjectTypes(),
];

export type SecurityRuleTypeWrapper = ReturnType<typeof createSecurityRuleTypeWrapper>;

/**
 * The sender of the events of a run, which is one per process: it queues what runs send, and the
 * process flushes the queue before it answers each run. Built when the first run sends, from what
 * Kibana said of its telemetry; without it (no telemetry plugin) nothing is sent, as in Kibana.
 */
const createRunEventsTelemetry = (
  host: RuleTypeModuleDeps['host'],
  config: SecurityRuleRunConfig,
  logger: RuleTypeModuleDeps['logger']
): RuleRunTelemetrySender | undefined => {
  if (!config.ruleRunTelemetry) return undefined;
  const settings = config.ruleRunTelemetry;
  let created: ReturnType<typeof createRuleRunTelemetrySender> | undefined;
  return {
    sendAsync: (channel, events) => {
      if (!created) {
        created = createRuleRunTelemetrySender({
          logger,
          settings,
          usageCounter: host.usageCounters?.getUsageCounter(APP_ID),
          analytics: host.analytics as never,
        });
        host.onRunEnd?.(created.flush);
      }
      created.sender.sendAsync(channel, events);
    },
  };
};

const kibanaOnly = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/**
 * What `createSecurityRuleTypeWrapper` takes, built from what the host of a task process gives the
 * module, with the same factories the plugin builds Kibana's with (`createSecurityRuleRunServices`).
 * Nothing is read from the host before a rule runs, so a module can build its rule type without one.
 */
export const createSecurityRuleRunServicesFromHost = (
  deps: RuleTypeModuleDeps
): CreateSecurityRuleTypeWrapperProps => {
  const { host, settings, logger } = deps;
  const config = settings[TASK_PROCESS_SETTINGS_ID] as SecurityRuleRunConfig | undefined;
  if (!config) {
    throw new Error(`The task process was not given the settings of ${TASK_PROCESS_SETTINGS_ID}`);
  }
  const alertingConfig = settings.alerting as AlertingConfig;

  let actionsConfig: ReturnType<typeof getActionsConfigurationUtilities> | undefined;
  let entityStore: ReturnType<typeof createEntityStoreRunServices> | undefined;

  return createSecurityRuleRunServices({
    ruleDataService: createRuleDataTaskProcessService(deps),
    // The lists plugin is optional, and without it a rule fails to run, as in Kibana.
    lists: settings[LISTS_TASK_PROCESS_SETTINGS_ID]
      ? createListsTaskProcessServices({ settings, logger })
      : undefined,
    actions: {
      // The config decides which action types are enabled; the license check of Kibana's service
      // needs the license state of the actions plugin, which a process does not have for this.
      isActionTypeEnabled: (actionTypeId) =>
        (actionsConfig ??= getActionsConfigurationUtilities(
          settings.actions as ActionsConfig
        )).isActionTypeEnabled(actionTypeId),
    },
    logger,
    config,
    publicBaseUrl: deps.publicBaseUrl,
    version: deps.kibanaVersion,
    isServerless: deps.isServerless,
    alerting: { getConfig: () => ({ run: alertingConfig.rules.run }) },
    analytics: host.analytics,
    licensing: {
      license$: defer(() => {
        if (!host.licensing) throw new Error('The module must declare the licensing capability');
        return host.licensing.license$;
      }),
    },
    ruleExecutionLoggerFactory: createRuleExecutionLogClientForExecutorsFactory({
      config,
      logger,
      getEventLog: () => host.eventLog as IEventLogService,
      getUiSettings: async () => deps.runtime.uiSettings,
    }),
    // Sent from here, before the run answers: Kibana does nothing with a run but reschedule it.
    eventsTelemetry: createRunEventsTelemetry(host, config, logger),
    getEntityStore: async () => (entityStore ??= createEntityStoreRunServices({ logger })),
    // Only the write paths of rules authorize a request, which Kibana serves.
    getRulesAuthz: kibanaOnly('Resolving the authorization of a request'),
    ...getResponseActionsServices(deps),
  });
};

/**
 * The task type of a detection rule type: `createRuleType` receives the wrapper that makes a security
 * rule type of an executor (the same one the plugin registers them with) and the deps of the module,
 * and returns the rule type.
 */
export const createSecurityRuleTaskType = (
  ruleTypeId: string,
  createRuleType: (wrap: SecurityRuleTypeWrapper, deps: RuleTypeModuleDeps) => unknown,
  { savedObjectTypes = [] }: { savedObjectTypes?: SavedObjectsType[] } = {}
): RuleTaskTypeModule =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: (deps) =>
        createRuleType(
          createSecurityRuleTypeWrapper(createSecurityRuleRunServicesFromHost(deps)),
          deps
        ) as UntypedRuleType,
    },
    {
      savedObjectTypes: [...SAVED_OBJECT_TYPES, ...savedObjectTypes],
      uiSettings: getSecurityRuleRunUiSettings(),
      // Core's security delegate and the authorization of the plugin, `host.plugins.security`.
      taskPlugins: [createSecurityTaskPlugin(kibanaPackageJson.version)],
      // The rule execution events, the plugin's settings and what Fleet encrypts for response actions.
      eventLogProviders: [
        { provider: RULE_EXECUTION_LOG_PROVIDER, actions: RuleExecutionEventType.options },
      ],
      // Core's analytics refuses the events of the plugin unless they are registered.
      analyticsEventTypes: securityEventTypes,
      settings: SETTINGS,
      optionalSettings: [FLEET_PACKAGE_METADATA_SETTINGS_ID],
      encryptedSavedObjectTypes: getFleetRunEncryptedSavedObjectTypes(),
    }
  );
