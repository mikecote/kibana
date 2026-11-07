/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of, Subject } from 'rxjs';
import { getDataStreamAdapter } from '@kbn/alerting-plugin/server';
import { AlertsService, errorResult } from '@kbn/alerting-plugin/server/alerts_service';
import type { AlertingConfig } from '@kbn/alerting-plugin/server/config';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { RuleRegistryPluginConfig } from '../config';
import { createRuleDataService } from '../rule_data_plugin_service/create_rule_data_service';
import type { RuleDataService } from '../rule_data_plugin_service/rule_data_plugin_service';
import { RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID } from './rule_data_task_process_services';

/** Builds rule data services for workflows with the same alert resources and shutdown lifecycle. */
export const createWorkflowRuleDataService = async (host: TaskHost): Promise<RuleDataService> => {
  const settings = host.settings ?? {};
  const config = settings[RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID] as
    | RuleRegistryPluginConfig
    | undefined;
  const alertingConfig = settings.alerting as AlertingConfig | undefined;
  if (!config || !alertingConfig || !host.onRunEnd) {
    throw new Error(
      'Workflow alert persistence requires rule registry and alerting settings and run cleanup'
    );
  }
  const pluginStop$ = new Subject<void>();
  host.onRunEnd(async () => {
    pluginStop$.next();
    pluginStop$.complete();
  });
  const dataStreamAdapter = getDataStreamAdapter({
    useDataStreamForAlerts: host.server.isServerless,
  });
  const alertsService = alertingConfig.enableFrameworkAlerts
    ? new AlertsService({
        logger: host.logger,
        pluginStop$,
        kibanaVersion: host.server.version,
        serverUuid: host.server.uuid,
        dataStreamAdapter,
        elasticsearchClientPromise: Promise.resolve(host.elasticsearch.asInternalUser),
        elasticsearchAndSOAvailability$: of(true),
        isServerless: host.server.isServerless,
        totalFieldsLimit: alertingConfig.alertsService.totalFieldsLimit,
      })
    : undefined;
  if (alertsService) {
    const initialized = await alertsService.getCommonInitializationPromise();
    if (!initialized.result) {
      throw new Error(`Unable to initialize workflow alert resources: ${initialized.error}`);
    }
  }
  return createRuleDataService({
    logger: host.logger,
    kibanaVersion: host.server.version,
    config,
    getClusterClient: async () => host.elasticsearch.asInternalUser,
    frameworkAlerts: {
      enabled: () => alertingConfig.enableFrameworkAlerts,
      getTotalFieldsLimit: () => alertingConfig.alertsService.totalFieldsLimit,
      getContextInitializationPromise: (context, namespace) =>
        alertsService?.getContextInitializationPromise(context, namespace) ??
        Promise.resolve(errorResult('Framework alerts are disabled')),
    },
    pluginStop$,
    dataStreamAdapter,
    elasticsearchAndSOAvailability$: of(true),
  });
};
