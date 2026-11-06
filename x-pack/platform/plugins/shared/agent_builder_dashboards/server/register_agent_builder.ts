/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { AgentBuilderSmlPluginSetup } from '@kbn/agent-builder-sml-plugin/server';
import type { DashboardServerClient } from '@kbn/dashboard-plugin/server/types';
import type { DashboardValidator } from '@kbn/dashboard-agent-authoring';
import { registerSkills } from './skills';
import { createDashboardAttachmentType } from './attachment_types';
import { createDashboardSmlType } from './sml_types';

/**
 * What the plugin registers with agent builder and the SML plugin: the dashboard attachment type and
 * SML type, and the dashboards skill. Called by `setup()` and by the `agent-builder` contribution to a
 * task process, with the services each has, so that both register the same.
 */
export const registerDashboardsAgentBuilder = (
  {
    agentBuilder,
    agentBuilderSml,
  }: {
    agentBuilder: AgentBuilderPluginSetup;
    agentBuilderSml: Pick<AgentBuilderSmlPluginSetup, 'registerType'>;
  },
  {
    logger,
    getDashboardClient,
    getDashboardValidator,
  }: {
    logger: Logger;
    getDashboardClient: () => Promise<DashboardServerClient>;
    getDashboardValidator: () => Promise<DashboardValidator>;
  }
) => {
  agentBuilder.attachments.registerType(
    createDashboardAttachmentType({
      logger,
      getDashboardClient,
    }) as Parameters<typeof agentBuilder.attachments.registerType>[0]
  );
  agentBuilderSml.registerType(createDashboardSmlType({ getDashboardClient }));
  registerSkills(agentBuilder, { getDashboardValidator });
};
