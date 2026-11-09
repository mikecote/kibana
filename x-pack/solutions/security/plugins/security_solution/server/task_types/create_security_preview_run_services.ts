/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContributionContext } from '@kbn/agent-builder-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { AlertingConfig } from '@kbn/alerting-plugin/server/config';
import { createTaskProcessAlertsService } from '@kbn/alerting-plugin/server/task_types/standalone/create_task_process_alerts_service';
import { createRuleDataTaskProcessService } from '@kbn/rule-registry-plugin/server';
import {
  createListsTaskProcessServices,
  LISTS_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/lists-plugin/server';
import type { RuleRunActionsStart } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import { TASK_PROCESS_SETTINGS_ID } from '../config';
import type { SecurityRuleRunConfig } from '../config';
import { createPreviewRuleDataClient } from '../lib/detection_engine/rule_preview/create_preview_rule_data_client';
import { getSecurityRuleAlerts } from '../lib/detection_engine/rule_types/create_security_rule_type_wrapper';
import type { LazyRunRulePreviewDeps } from '../lib/detection_engine/rule_preview/api/preview_rules/run_rule_preview';
import type { CreateSecurityRuleTypeWrapperProps } from '../lib/detection_engine/rule_types/types';
import type { EndpointWorkflowServices } from './endpoint_workflow_services';
import type { SecurityAgentBuilderSettings } from './agent_builder_settings';
import { createRunEventsTelemetry } from './create_run_events_telemetry';

/** Builds rule preview execution services from the same owning SDKs as Main. */
export const createSecurityPreviewRunServices = async ({
  host,
  settings,
  services,
  logger,
  kibanaVersion,
  snapshot,
}: Pick<AgentBuilderContributionContext, 'settings' | 'services' | 'logger' | 'kibanaVersion'> & {
  host: TaskHost;
  snapshot: SecurityAgentBuilderSettings;
}): Promise<Awaited<ReturnType<LazyRunRulePreviewDeps['getPreviewRunServices']>>> => {
  const config = settings[TASK_PROCESS_SETTINGS_ID] as SecurityRuleRunConfig | undefined;
  const alertingConfig = settings.alerting as AlertingConfig | undefined;
  if (!config || !alertingConfig || !host.licensing || typeof snapshot.plugins.lists !== 'boolean')
    throw new Error(
      'Native rule preview requires its rule, license and plugin availability snapshots'
    );
  if (snapshot.plugins.lists && !settings[LISTS_TASK_PROCESS_SETTINGS_ID])
    throw new Error('Native rule preview requires the enabled Lists configuration');
  const endpoint = await services
    .getService<EndpointWorkflowServices>('securitySolution.endpoint')
    .getServices();
  const alertsService = createTaskProcessAlertsService(
    host,
    alertingConfig,
    logger.get('alerting')
  );
  alertsService?.register(getSecurityRuleAlerts(config));
  const ruleDataService = createRuleDataTaskProcessService({
    host,
    settings,
    logger: logger.get('ruleRegistry'),
    kibanaVersion,
    isServerless: host.server.isServerless,
    runtime: { alertsService },
  });
  return {
    previewRuleDataClient: createPreviewRuleDataClient(ruleDataService, config),
    securityRuleTypeOptions: {
      lists: snapshot.plugins.lists
        ? createListsTaskProcessServices({ settings, logger })
        : undefined,
      actions: services.getService<Pick<RuleRunActionsStart, 'isActionTypeEnabled'>>('actions'),
      logger,
      config,
      publicBaseUrl: host.server.publicBaseUrl,
      version: kibanaVersion,
      isServerless: host.server.isServerless,
      experimentalFeatures: config.experimentalFeatures,
      alerting: { getConfig: () => ({ run: alertingConfig.rules.run }) },
      analytics: host.analytics,
      eventsTelemetry: createRunEventsTelemetry(host, config, logger),
      licensing: { license$: host.licensing.license$ },
      scheduleNotificationResponseActionsService:
        endpoint.scheduleNotificationResponseActionsService,
      endpointAppContextService: endpoint.endpointAppContextService,
      getEntityStore: async () =>
        services.getService<
          Awaited<ReturnType<CreateSecurityRuleTypeWrapperProps['getEntityStore']>>
        >('entityStore'),
    },
  };
};
