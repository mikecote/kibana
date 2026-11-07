/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createAttackDiscoveryAttachmentType } from '../agent_builder/attachments/attack_discovery';
import { createAttackDiscoveryVerdictAttachmentType } from '../agent_builder/attachments/attack_discovery_verdict';
import { createDiagnosticReportAttachmentType } from '../agent_builder/attachments/diagnostic_report';
import { registerSkills } from '../agent_builder/skills/register_skills';
import {
  DISCOVERIES_TASK_PROCESS_SETTINGS_ID,
  type DiscoveriesTaskProcessSettings,
} from './discoveries_task_process_settings';
import {
  DISCOVERIES_PROCESS_SERVICES_ID,
  type DiscoveriesProcessServices,
} from './discoveries_process_services';

export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [DISCOVERIES_TASK_PROCESS_SETTINGS_ID],
    featureFlags: { [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true },
  },
  register: async (agentBuilder, { settings, services, host, logger }) => {
    const snapshot = (
      settings[DISCOVERIES_TASK_PROCESS_SETTINGS_ID] as DiscoveriesTaskProcessSettings | undefined
    )?.agentBuilder;
    if (!snapshot) return;
    const taskHost = host as TaskHost;
    const getRuntime = () =>
      services.getService<DiscoveriesProcessServices>(DISCOVERIES_PROCESS_SERVICES_ID);
    const attachments = [
      createAttackDiscoveryAttachmentType({
        adhocAttackDiscoveryDataClient: () => getRuntime().adhocAttackDiscoveryDataClient,
        esClient: taskHost.elasticsearch,
        logger,
      }),
      createDiagnosticReportAttachmentType(),
      createAttackDiscoveryVerdictAttachmentType(),
    ];
    for (const attachment of attachments) {
      if (snapshot.attachmentTypeIds.includes(attachment.id))
        agentBuilder.attachments.registerType(attachment);
    }
    const workflowsManagementApi: WorkflowsManagementApi = {
      getWorkflow: (...args) => getRuntime().workflowsManagementApi.getWorkflow(...args),
      getWorkflowExecution: (...args) =>
        getRuntime().workflowsManagementApi.getWorkflowExecution(...args),
      runWorkflow: (...args) => getRuntime().workflowsManagementApi.runWorkflow(...args),
      scheduleWorkflow: (...args) => getRuntime().workflowsManagementApi.scheduleWorkflow(...args),
    };
    const getEventLogIndex = () => getRuntime().getEventLogIndex();
    const getStartServices = () => getRuntime().getStartServices();
    await registerSkills(agentBuilder, logger, {
      skillIds: snapshot.skillIds,
      getEventLogIndex,
      getStartServices,
      workflowExecutionLookup: workflowsManagementApi,
      workflowFetcher: workflowsManagementApi,
      runAttackDiscoveryToolDeps: {
        runGeneration: (args) => getRuntime().runGeneration(args),
        analytics: () => getRuntime().analytics,
        getEventLogIndex,
        getEventLogger: () => getRuntime().getEventLogger(),
        getStartServices,
        logger,
        workflowsManagementApi,
      },
    });
  },
};
