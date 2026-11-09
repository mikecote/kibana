/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createNativeEmbeddables } from '@kbn/embeddable-plugin/server/task_process/create_native_embeddables';
import {
  EMBEDDABLE_CONTRIBUTIONS_KEY,
  EMBEDDABLE_RUNTIME_SETTINGS_ID,
} from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import type {
  EmbeddableContribution,
  EmbeddableRegistrationIds,
} from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import type { EmbeddableStart } from '@kbn/embeddable-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { createDashboardSavedObjectType } from '@kbn/dashboard-plugin/server/dashboard_saved_object';
import { createDashboardServerClient } from '@kbn/dashboard-plugin/server/create_dashboard_server_client';
import { registerDashboardsAgentBuilder } from '../register_agent_builder';
import { createDashboardAppStateValidator } from '../tools/generate/validate_dashboard_app_state';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const DASHBOARDS_AGENT_BUILDER_SETTINGS_ID = 'agentBuilderDashboards';

/** Registers dashboard tools against the native dashboard and embeddable SDKs. */
export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [DASHBOARDS_AGENT_BUILDER_SETTINGS_ID, EMBEDDABLE_RUNTIME_SETTINGS_ID],
    createSavedObjectTypes: (_encryption, settings, registry) => {
      if (!settings[DASHBOARDS_AGENT_BUILDER_SETTINGS_ID]) return [];
      const expected = settings[EMBEDDABLE_RUNTIME_SETTINGS_ID] as
        | EmbeddableRegistrationIds
        | undefined;
      if (!expected)
        throw new Error('Native dashboard migrations require embeddable registration metadata');
      const embeddables = createNativeEmbeddables(
        registry.getContributions<EmbeddableContribution>(EMBEDDABLE_CONTRIBUTIONS_KEY),
        expected,
        { settings, getContributions: registry.getContributions }
      );
      return [createDashboardSavedObjectType({ migrationDeps: { embeddable: embeddables.setup } })];
    },
  },
  register: (agentBuilder, { logger, settings, services, registerSmlType }) => {
    if (!settings[DASHBOARDS_AGENT_BUILDER_SETTINGS_ID]) return;
    let client: ReturnType<typeof createDashboardServerClient> | undefined;
    registerDashboardsAgentBuilder(
      { agentBuilder, agentBuilderSml: { registerType: registerSmlType } },
      {
        logger,
        getDashboardClient: async () => {
          client ??= createDashboardServerClient({
            embeddable: services.getService<EmbeddableStart>('embeddable'),
            logger: logger.get('dashboard'),
          });
          return client;
        },
        getDashboardValidator: async () =>
          createDashboardAppStateValidator(services.getService<EmbeddableStart>('embeddable')),
      }
    );
  },
};
