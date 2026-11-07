/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SharedServices } from '@kbn/ml-plugin/server/shared_services/shared_services';
import type { ApmDataAccessPluginSetup } from '@kbn/apm-data-access-plugin/server';
import type { SLOServerStart } from '@kbn/slo-plugin/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { APMConfig } from '..';
import { createApmToolResources } from '../agent_builder/utils/build_apm_tool_resources';
import { registerNativeApmDataProviders } from '../agent_builder/data_provider/register_data_providers';

export const APM_WORKFLOW_SETTINGS_ID = 'apmWorkflowRuntime';
export interface ApmWorkflowSettings {
  config: APMConfig;
  mlEnabled: boolean;
  sloEnabled: boolean;
}

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [APM_WORKFLOW_SETTINGS_ID],
  },
  provides: {
    'observabilityAgentBuilder.dataProviders.apm': ({
      host: taskHost,
      settings,
      services,
    }): Partial<ObservabilityAgentBuilderDataRegistryTypes> => {
      const snapshot = settings[APM_WORKFLOW_SETTINGS_ID] as ApmWorkflowSettings | undefined;
      if (!snapshot || !services)
        throw new Error('APM data providers are not enabled in the dispatching Kibana');
      const host = taskHost as TaskHost;
      const { licensing, uiSettings } = host;
      if (!licensing || !uiSettings)
        throw new Error('APM data providers require native licensing and UI settings');
      const apmDataAccess = services.getService<ApmDataAccessPluginSetup>('apmDataAccess.setup');
      const ml = snapshot.mlEnabled ? services.getService<SharedServices>('ml.setup') : undefined;
      const slo = snapshot.sloEnabled ? services.getService<SLOServerStart>('slo') : undefined;
      const ruleRegistry = services.getService<WorkflowRuleRegistryServices>('ruleRegistry');
      const providers: Partial<ObservabilityAgentBuilderDataRegistryTypes> = {};
      registerNativeApmDataProviders({
        registerDataProvider: (id, provider) => {
          providers[id] = provider;
        },
        getResources: (request: KibanaRequest) =>
          createApmToolResources({
            coreStart: {
              elasticsearch: { client: host.elasticsearch },
              savedObjects: host.savedObjects,
              uiSettings,
              security: host.security,
            },
            pluginStart: { licensing, ruleRegistry, slo },
            plugins: { apmDataAccess, ml },
            request,
          }),
        config: snapshot.config,
        logger: host.logger.get('apm', 'observabilityAgentBuilder'),
      });
      return providers;
    },
  },
  register: () => {},
};
