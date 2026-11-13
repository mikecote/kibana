/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { ALERTZERO_ENABLED_SETTING_ID } from '@kbn/alertzero-common';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { ensureAgentSafe } from '../agent/ensure_agent';
import { registerAlertZeroAgentBuilder } from '../agent_builder/register_agent_builder';
import { createAssertAlertZeroAccess } from '../agent_builder_tools/assert_alertzero_access';
import { ActionsService } from '../services/actions/actions_service';
import {
  WatchWorkflowsManagementClientImpl,
  type WatchWorkflowsManagementApi,
} from '../services/watches/watch_workflows_management_client';
import {
  ALERTZERO_AGENT_BUILDER_SETTINGS_ID,
  type AlertZeroAgentBuilderTaskProcessSettings,
} from './alertzero_agent_builder_task_process_settings';

export const contribution: AgentBuilderContribution = {
  declares: { settings: [ALERTZERO_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { host, services, settings, logger }) => {
    const snapshot = settings[ALERTZERO_AGENT_BUILDER_SETTINGS_ID] as
      | AlertZeroAgentBuilderTaskProcessSettings
      | undefined;
    if (!snapshot) return;
    let actions: ActionsService | undefined;
    const assertAlertZeroAccess = createAssertAlertZeroAccess(async () => ({
      core: await services.getCoreStart(),
      security: (host as TaskHost).plugins?.security as SecurityTaskPluginStart | undefined,
    }));
    registerAlertZeroAgentBuilder({
      agentBuilder,
      assertAlertZeroAccess,
      getActionsService: () => {
        if (!snapshot.actionsAvailable)
          throw new Error(
            'Actions service is not available until the AlertZero plugin has started'
          );
        actions ??= new ActionsService(
          () =>
            snapshot.managementAvailable
              ? new WatchWorkflowsManagementClientImpl(
                  services.getService<WatchWorkflowsManagementApi>('workflows.management')
                )
              : undefined,
          logger
        );
        return actions;
      },
      isEnabledForRequest: async (request) => {
        const { savedObjects, uiSettings } = await services.getCoreStart();
        return uiSettings
          .asScopedToClient(savedObjects.getScopedClient(request))
          .get<boolean>(ALERTZERO_ENABLED_SETTING_ID);
      },
    });
  },
  registerAtStart: async (agentBuilder, { settings, logger }) => {
    const snapshot = settings[ALERTZERO_AGENT_BUILDER_SETTINGS_ID] as
      | AlertZeroAgentBuilderTaskProcessSettings
      | undefined;
    if (snapshot?.actionsAvailable)
      await ensureAgentSafe({ agentBuilder, spaceId: DEFAULT_SPACE_ID, logger });
  },
};
