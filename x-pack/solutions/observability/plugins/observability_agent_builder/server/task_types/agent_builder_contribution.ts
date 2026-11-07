/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { LogsDataAccessPluginStart } from '@kbn/logs-data-access-plugin/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import type {
  ObservabilityAgentBuilderRunCore,
  ObservabilityAgentBuilderRunSetupDependencies,
} from '../run_services/types';
import { createObservabilityTaskDataRegistry } from './create_data_registry';
import { registerTools } from '../tools/register_tools';
import { registerAttachments } from '../attachments/register_attachments';
import { registerSkills } from '../skills/register_skills';
import { OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID } from './observability_agent_builder_task_process_settings';
import type { ObservabilityAgentBuilderTaskProcessSettings } from './observability_agent_builder_task_process_settings';

export const contribution: AgentBuilderContribution = {
  declares: { settings: [OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID] },
  register: async (agentBuilder, { host: taskHost, settings, services, logger }) => {
    const snapshot = settings[OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID] as
      | ObservabilityAgentBuilderTaskProcessSettings
      | undefined;
    if (!snapshot) return;
    const host = taskHost as TaskHost;
    const dataRegistry = createObservabilityTaskDataRegistry({
      snapshot,
      getService: services.getService,
      logger,
    });
    const core: ObservabilityAgentBuilderRunCore = {
      getStartServices: async () => {
        const { licensing } = host;
        if (!licensing) throw new Error('Observability execution requires native licensing');
        return [
          { elasticsearch: { client: host.elasticsearch }, savedObjects: host.savedObjects },
          {
            logsDataAccess: services.getService<LogsDataAccessPluginStart>('logsDataAccess'),
            licensing,
            ruleRegistry: services.getService<WorkflowRuleRegistryServices>('ruleRegistry'),
            ...(snapshot.spacesEnabled
              ? { spaces: services.getService<SpacesPluginStart>('spaces') }
              : {}),
          },
          {},
        ];
      },
    };
    const plugins: ObservabilityAgentBuilderRunSetupDependencies = {
      agentBuilder,
      get apmDataAccess() {
        return services.getService<ObservabilityAgentBuilderRunSetupDependencies['apmDataAccess']>(
          'apmDataAccess.setup'
        );
      },
      get metricsDataAccess() {
        return services.getService<
          ObservabilityAgentBuilderRunSetupDependencies['metricsDataAccess']
        >('metricsDataAccess.setup');
      },
      get ml() {
        return snapshot.mlEnabled
          ? services.getService<NonNullable<ObservabilityAgentBuilderRunSetupDependencies['ml']>>(
              'ml.setup'
            )
          : undefined;
      },
    };
    registerSkills({ plugins, logger, skillIds: snapshot.registrations.skillIds });
    await registerTools({
      core,
      plugins,
      dataRegistry,
      logger,
      toolIds: snapshot.registrations.toolIds,
    });
    await registerAttachments({
      core,
      plugins,
      dataRegistry,
      logger,
      attachmentTypeIds: snapshot.registrations.attachmentTypeIds,
    });
  },
};
