/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SharedServices } from '@kbn/ml-plugin/server/shared_services/shared_services';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { ApmDataAccessPluginSetup } from '@kbn/apm-data-access-plugin/server';
import type { MetricsDataPluginSetup } from '@kbn/metrics-data-access-plugin/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { MetricsDataDefaultIndicesProvider } from '@kbn/metrics-data-access-plugin/server';
import {
  createInfraToolResources,
  registerNativeInfraDataProviders,
} from '../agent_builder/register_data_providers';
import { createInfraSources } from '../lib/alerting/create_infra_alerting_libs';
import { infraSourceConfigurationSavedObjectType } from '../lib/sources/saved_object_type';

export const INFRA_WORKFLOW_SETTINGS_ID = 'infraWorkflowRuntime';
export interface InfraWorkflowSettings {
  mlEnabled: boolean;
  spacesEnabled: boolean;
}

export const contribution: WorkflowStepsContribution = {
  declares: {
    savedObjectTypes: [infraSourceConfigurationSavedObjectType],
    settings: [INFRA_WORKFLOW_SETTINGS_ID],
  },
  provides: {
    'observabilityAgentBuilder.dataProviders.infra': ({
      host: taskHost,
      settings,
      services,
    }): Pick<ObservabilityAgentBuilderDataRegistryTypes, 'infraHosts'> => {
      const snapshot = settings[INFRA_WORKFLOW_SETTINGS_ID] as InfraWorkflowSettings | undefined;
      if (!snapshot || !services)
        throw new Error('Infrastructure data providers are not enabled in the dispatching Kibana');
      const host = taskHost as TaskHost;
      const { uiSettings } = host;
      if (!uiSettings) throw new Error('Infrastructure data providers require native UI settings');
      const metricsDataAccess =
        services.getService<MetricsDataPluginSetup>('metricsDataAccess.setup');
      const apmDataAccess = services.getService<ApmDataAccessPluginSetup>('apmDataAccess.setup');
      const ruleRegistry = services.getService<WorkflowRuleRegistryServices>('ruleRegistry');
      const ml = snapshot.mlEnabled ? services.getService<SharedServices>('ml.setup') : undefined;
      const spaces = snapshot.spacesEnabled
        ? services.getService<SpacesPluginStart>('spaces')
        : undefined;
      let infraHosts: ObservabilityAgentBuilderDataRegistryTypes['infraHosts'] | undefined;
      registerNativeInfraDataProviders({
        registerDataProvider: (_id, provider) => {
          infraHosts = provider;
        },
        getResources: (request) => {
          const savedObjectsClient = host.savedObjects.getScopedClient(request);
          return createInfraToolResources({
            coreContext: {
              savedObjects: { client: savedObjectsClient },
              uiSettings: { client: uiSettings.asScopedToClient(savedObjectsClient) },
              elasticsearch: { client: host.elasticsearch.asScoped(request) },
            },
            request,
            plugins: { metricsDataAccess, ml, spaces },
            ruleRegistry,
            apmDataAccess,
          });
        },
        logger: host.logger.get('infra', 'observabilityAgentBuilder'),
      });
      if (!infraHosts) throw new Error('The native Infrastructure provider was not registered');
      return { infraHosts };
    },
    'metricsDataAccess.defaultIndices.infra': (): MetricsDataDefaultIndicesProvider => ({
      configure: (metricsClient) => {
        createInfraSources({ metricsClient });
      },
    }),
  },
  register: () => {},
};
