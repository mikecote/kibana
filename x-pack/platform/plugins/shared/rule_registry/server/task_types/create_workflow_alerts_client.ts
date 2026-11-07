/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AlertingAuthorization } from '@kbn/alerting-plugin/server';
import { createGetAlertIndicesAliasFn } from '@kbn/alerting-plugin/server/lib/create_get_alert_indices_alias';
import {
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
  createAlertingAuthorizationRegistry,
} from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import type { AlertingAuthorizationTaskProcessSettings } from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { KibanaFeature } from '@kbn/features-plugin/common';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContributionServices } from '@kbn/workflows-extensions/server';
import type { RuleRegistryPluginStartContract } from '../plugin';
import { AlertsClientFactory } from '../alert_data_client/alerts_client_factory';
import { createWorkflowRuleDataService } from './workflow_rule_data_services';

export type WorkflowRuleRegistryServices = Pick<
  RuleRegistryPluginStartContract,
  'getRacClientWithRequest'
>;

const createFactory = async (
  host: TaskHost,
  services: WorkflowStepsContributionServices
): Promise<AlertsClientFactory> => {
  const snapshot = host.settings?.[ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID] as
    | AlertingAuthorizationTaskProcessSettings
    | undefined;
  if (!snapshot)
    throw new Error('Authorized alert clients require the native alerting registration snapshot');
  const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
  if (snapshot.securityEnabled && !security)
    throw new Error('Authorized alert clients require native Security services');
  const spaces = snapshot.spacesEnabled
    ? services.getService<SpacesPluginStart>('spaces')
    : undefined;
  const registry = createAlertingAuthorizationRegistry(snapshot);
  const features = snapshot.features.map((feature) => new KibanaFeature(feature));
  const ruleDataService = await createWorkflowRuleDataService(host);
  const factory = new AlertsClientFactory();
  factory.initialize({
    logger: host.logger.get('ruleRegistry'),
    esClient: host.elasticsearch.asInternalUser,
    getEsClientScoped: async (request) => host.elasticsearch.asScoped(request).asCurrentUser,
    getAlertingAuthorization: (request) =>
      AlertingAuthorization.create({
        request,
        ruleTypeRegistry: registry,
        features: { getKibanaFeatures: () => features },
        authorization: snapshot.securityEnabled ? security?.authz : undefined,
        getSpace: async (scopedRequest) => spaces?.spacesService.getActiveSpace(scopedRequest),
        getSpaceId: (scopedRequest) =>
          spaces?.spacesService.getSpaceId(scopedRequest) ?? DEFAULT_SPACE_ID,
      }),
    securityPluginSetup:
      snapshot.securityEnabled && security ? { audit: security.audit } : undefined,
    ruleDataService,
    getRuleList: registry.list,
    getAlertIndicesAlias: createGetAlertIndicesAliasFn(registry),
  });
  return factory;
};

/** Creates native authorized alert clients from the current dispatch's catalog and scoped services. */
export const createWorkflowAlertsClient = (
  host: TaskHost,
  services: WorkflowStepsContributionServices
): WorkflowRuleRegistryServices => {
  let factory: Promise<AlertsClientFactory> | undefined;
  return {
    getRacClientWithRequest: async (request) =>
      (await (factory ??= createFactory(host, services))).create(request),
  };
};
