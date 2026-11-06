/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of, Subject } from 'rxjs';
import { getDataStreamAdapter } from '@kbn/alerting-plugin/server';
import type { PublicFrameworkAlertsService } from '@kbn/alerting-plugin/server';
import type { AlertingConfig } from '@kbn/alerting-plugin/server/config';
import { errorResult } from '@kbn/alerting-plugin/server/alerts_service';
import type { RuleTypeModuleDeps } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { RuleRegistryPluginConfig } from '../config';
import { createRuleDataService } from '../rule_data_plugin_service/create_rule_data_service';

/** The id of the plugin's settings in a task process, `host.settings[id]`. */
export const RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID = 'ruleRegistry';

/**
 * The rule data service a rule type of a task process writes its alerts with, built from what the
 * host gives the module, and what Kibana's own service is built from.
 *
 * Nothing is read from the host before a rule runs, so a module can build its rule type without
 * one, and the alerts resources the framework installs for the rule type are the runtime's, which
 * the module registers once the runtime exists. Initializing the service installs the common and
 * index-level resources, as in Kibana, but both installers compare content hashes with what is
 * installed and write nothing when Kibana has already installed them.
 */
export const createRuleDataTaskProcessService = (
  deps: Pick<RuleTypeModuleDeps, 'host' | 'runtime' | 'settings' | 'logger' | 'kibanaVersion'> &
    Pick<RuleTypeModuleDeps, 'isServerless'>
) => {
  const { host, settings } = deps;
  const alertingConfig = settings.alerting as AlertingConfig;
  const config = settings[RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID] as
    | RuleRegistryPluginConfig
    | undefined;
  if (!config) {
    throw new Error(
      `The task process was not given the settings of ${RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID}`
    );
  }

  // The runtime exists once a rule runs, which is also when the service first reads this.
  const frameworkAlerts: PublicFrameworkAlertsService = {
    enabled: () => alertingConfig.enableFrameworkAlerts,
    getTotalFieldsLimit: () => alertingConfig.alertsService.totalFieldsLimit,
    getContextInitializationPromise: (context, namespace) =>
      deps.runtime?.alertsService
        ? deps.runtime.alertsService.getContextInitializationPromise(context, namespace)
        : Promise.resolve(errorResult('Framework alerts service not available')),
  };

  return createRuleDataService({
    logger: deps.logger,
    kibanaVersion: deps.kibanaVersion,
    config,
    getClusterClient: async () => host.elasticsearch.asInternalUser,
    frameworkAlerts,
    pluginStop$: new Subject<void>(),
    dataStreamAdapter: getDataStreamAdapter({ useDataStreamForAlerts: deps.isServerless }),
    elasticsearchAndSOAvailability$: of(true),
  });
};
