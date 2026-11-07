/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { registerWorkflowsAgentBuilder } from '../register_agent_builder';
import { WorkflowsAiTelemetryClient } from '../telemetry/workflows_ai_telemetry_client';
import {
  WORKFLOWS_AI_EDIT_RESULT_EVENT_TYPE,
  workflowsAiEditResultSchema,
} from '../telemetry/events/workflows_ai_edit_result';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const WORKFLOWS_AGENT_BUILDER_SETTINGS_ID = 'agentBuilderWorkflows';

/**
 * What the plugin registers with agent builder and the SML plugin, in the task process of the workflow
 * task types: the same registrations as `setup()`, over the workflows management API a process serves
 * (`services.getWorkflowsManagement()`).
 *
 * Differences from Kibana: the API is the one of `createWorkflowsProcessManagementApi`, which reads and
 * runs saved workflows. The tools that need the workflows service of Kibana (validating, the step and
 * trigger definitions, connectors, executing a step, resuming, listing executions, generating a
 * workflow) are registered and fail with "only available in Kibana" when called, and the workflow SML
 * type, which is crawled in Kibana, cannot list.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [WORKFLOWS_AGENT_BUILDER_SETTINGS_ID],
    analyticsEventTypes: [
      {
        eventType: WORKFLOWS_AI_EDIT_RESULT_EVENT_TYPE,
        schema: workflowsAiEditResultSchema,
      },
    ],
  },
  register: (agentBuilder, { host, logger, settings, services, registerSmlType }) => {
    if (!settings[WORKFLOWS_AGENT_BUILDER_SETTINGS_ID]) return;
    const taskHost = host as TaskHost;
    // The management API is read lazily by the tools; the registrations only hold on to it.
    const workflowsManagement = {
      get management() {
        return services.getWorkflowsManagement();
      },
    } as WorkflowsServerPluginSetup;
    registerWorkflowsAgentBuilder(
      { agentBuilder, agentBuilderSml: { registerType: registerSmlType } },
      {
        workflowsManagement,
        getSecurity: () => taskHost.plugins?.security as unknown as SecurityPluginStart | undefined,
        aiTelemetryClient: new WorkflowsAiTelemetryClient(
          {
            reportEvent: (...args: Parameters<TaskHost['analytics']['reportEvent']>) =>
              taskHost.analytics.reportEvent(...args),
            registerEventType: () => {},
          } as never,
          logger.get('workflows')
        ),
      }
    );
  },
};
