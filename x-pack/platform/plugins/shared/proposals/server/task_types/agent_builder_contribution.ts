/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import { registerProposalsAgentBuilder } from '../agent_builder/register_agent_builder';
import { createProposalPrivilegesChecker } from '../services/check_proposal_privileges';
import type { ProposalsService } from '../services/proposals_service';
import { createProposalsRunServices } from './create_proposals_run_services';

/** The id of the settings the plugin sends a task process: sent whenever the plugin is enabled. */
export const PROPOSALS_AGENT_BUILDER_SETTINGS_ID = 'proposalsAgentBuilder';

/**
 * What the proposals plugin registers with agent builder, in the task process of the workflow task
 * types: the revise and create tools, the management skill and the proposal attachment type, which
 * `setup()` registers with the same function. The service is built by `createProposalsRunServices`
 * over the host of the process; the workflows API is the one of the process (reading and running
 * saved workflows), and the attachments client is agent builder's own. Without the setting the
 * plugin is not enabled in this Kibana, and nothing is registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [PROPOSALS_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { host, logger, settings, services }) => {
    if (!settings[PROPOSALS_AGENT_BUILDER_SETTINGS_ID]) return;
    // What the registrations read of the host is read when a tool runs, not while registering.
    const { elasticsearch, security, userProfile, plugins } = host as TaskHost & {
      userProfile?: CoreStart['userProfile'];
    };
    const proposalsLogger = logger.get('proposals');
    const getWorkflowsApi = () =>
      services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'];
    const privileges = createProposalPrivilegesChecker({
      getSecurity: async () => {
        const securityPlugin = plugins?.security as SecurityTaskPluginStart | undefined;
        if (!securityPlugin) throw new Error('The task process did not get the security plugin');
        return securityPlugin as unknown as SecurityPluginStart;
      },
      logger: proposalsLogger,
    });
    let service: ProposalsService | undefined;
    const getProposalsService = () => {
      if (!service) {
        if (!userProfile) {
          throw new Error('The task process host did not lend Core user profile service');
        }
        service = createProposalsRunServices({
          logger: proposalsLogger,
          esClient: elasticsearch.asInternalUser,
          security: security as CoreStart['security'],
          userProfile,
          getWorkflowsApi,
          getAttachmentsClient: (request) =>
            services.getAgentBuilderStart().attachments.getScopedClient({ request }),
        }).getProposalsService();
      }
      return service;
    };
    registerProposalsAgentBuilder(agentBuilder, {
      getProposalsService,
      getWorkflowsApi,
      privileges,
      logger: proposalsLogger,
    });
  },
};
