/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { ALERTING_V2_ENABLED_SETTING_ID } from '@kbn/alerting-v2-constants';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import {
  createAlertingV2AttachmentTypes,
  createAlertingV2SmlTypes,
} from '../agent_builder/create_integrations';
import { registerSkills } from '../agent_builder/skills/register_skills';
import { createAlertingV2Availability } from '../agent_builder/skills/alerting_v2_availability';
import { LoggerService } from '../lib/services/logger_service/logger_service';
import type { AlertingV2RunServices } from './create_alerting_v2_run_services';
import {
  ALERTING_V2_TASK_PROCESS_SETTINGS_ID,
  type AlertingV2TaskProcessSettings,
} from './task_process_settings';

export const contribution: AgentBuilderContribution = {
  declares: { settings: [ALERTING_V2_TASK_PROCESS_SETTINGS_ID] },
  register: (agentBuilder, { host, logger, settings, services, registerSmlType }) => {
    const snapshot = settings[ALERTING_V2_TASK_PROCESS_SETTINGS_ID] as
      | AlertingV2TaskProcessSettings
      | undefined;
    if (!snapshot?.agentBuilderEnabled) return;
    const getRuntime = () => services.getService<AlertingV2RunServices>('alertingV2.runtime');
    const resolve: AlertingV2RunServices['resolve'] = (request, token) =>
      getRuntime().resolve(request, token);
    const agentLogger = new LoggerService(logger.get('alertingVTwo')).forSubsystem('agentBuilder');
    for (const type of createAlertingV2AttachmentTypes({ logger: agentLogger, resolve })) {
      agentBuilder.attachments.registerType(type);
    }
    if (snapshot.smlEnabled) {
      for (const definition of createAlertingV2SmlTypes({
        resolve,
        getIsAlertingV2Enabled: () => {
          const taskHost = host as TaskHost;
          if (!taskHost.uiSettings) throw new Error('Alerting v2 requires global UI settings');
          return taskHost.uiSettings
            .globalAsScopedToClient(taskHost.savedObjects.createInternalRepository())
            .get<boolean>(ALERTING_V2_ENABLED_SETTING_ID);
        },
      }))
        registerSmlType(definition);
    }
    const getManagement = () =>
      services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'];
    registerSkills(agentBuilder, {
      logger: agentLogger,
      getWorkflowClient: (request) => getManagement().getClient(request),
      getAvailableConnectors: (spaceId, request) =>
        getManagement().getAvailableConnectors(spaceId, request),
      validateWorkflow: (yaml, spaceId, request) =>
        getManagement().validateWorkflow(yaml, spaceId, request),
      availability: createAlertingV2Availability({
        projectType: snapshot.projectType,
        getActiveSpace: (request) =>
          services.getService<SpacesPluginStart>('spaces').spacesService.getActiveSpace(request),
      }),
    });
  },
};
