/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableStart } from '@kbn/embeddable-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { createDashboardSavedObjectType } from '@kbn/dashboard-plugin/server/dashboard_saved_object';
import { createDashboardServerClient } from '@kbn/dashboard-plugin/server/create_dashboard_server_client';
import { setReadOnlyKibanaServices } from '@kbn/dashboard-plugin/server/kibana_services';
import { registerDashboardsAgentBuilder } from '../register_agent_builder';
import { createDashboardAppStateValidator } from '../tools/generate/validate_dashboard_app_state';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const DASHBOARDS_AGENT_BUILDER_SETTINGS_ID = 'agentBuilderDashboards';

// A process has no plugins that register embeddable transforms and schemas (lens, maps ...).
const emptyEmbeddable = {
  getTransforms: () => undefined,
  getAllEmbeddableSchemas: () => ({}),
} as unknown as EmbeddableStart;

/**
 * What the plugin registers with agent builder and the SML plugin, in the task process of the workflow
 * task types: the same registrations as `setup()`, over the dashboard client of the plugin
 * (`createDashboardServerClient`) read with the saved objects of the process.
 *
 * Differences from Kibana: the embeddable transforms and schemas other plugins register in their `setup()`
 * (lens, maps and so on) do not exist in a process, so the panels of a dashboard are read, and the
 * panels of a generated dashboard validated, without them.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [DASHBOARDS_AGENT_BUILDER_SETTINGS_ID],
    // The embeddable migrations of other plugins are not applied: Kibana migrates what it reads.
    savedObjectTypes: [
      createDashboardSavedObjectType({
        migrationDeps: { embeddable: { getAllMigrations: () => ({}) } as never },
      }),
    ],
  },
  register: (agentBuilder, { logger, settings, registerSmlType }) => {
    if (!settings[DASHBOARDS_AGENT_BUILDER_SETTINGS_ID]) return;
    setReadOnlyKibanaServices(emptyEmbeddable, logger.get('dashboard'));
    const client = createDashboardServerClient();
    registerDashboardsAgentBuilder(
      { agentBuilder, agentBuilderSml: { registerType: registerSmlType } },
      {
        logger,
        getDashboardClient: async () => client,
        getDashboardValidator: async () => createDashboardAppStateValidator(emptyEmbeddable),
      }
    );
  },
};
