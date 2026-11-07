/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createProposalPrivilegesChecker } from '../services/check_proposal_privileges';
import { registerStepDefinitions } from '../step_types';
import { createProposalsRunServices } from './create_proposals_run_services';
import type { ProposalsPluginStart } from '../types';

/**
 * The proposal steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The service is built with the class
 * Kibana builds: its storage over the internal client, the read API of the workflows management
 * plugin over the engine's execution storage, and the privilege checks of the security task plugin.
 *
 * Creating and cloning proposals use this run's Agent Builder attachments and shared workflow
 * management runtime, with the same authorization as Kibana.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, logger, services }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const { elasticsearch, security, userProfile, plugins } = host as TaskHost;
    const authz = plugins?.security as Pick<SecurityPluginStart, 'authz'> | undefined;
    if (!userProfile)
      throw new Error('The task process host did not lend Core user profile service');
    if (!authz) throw new Error('The task process did not get the security plugin');

    const proposalsLogger = logger.get('proposals');
    const esClient = elasticsearch.asInternalUser;

    const privileges = createProposalPrivilegesChecker({
      getSecurity: async () => authz,
      logger: proposalsLogger,
    });
    const { resolveUser, getProposalsService } = createProposalsRunServices({
      logger: proposalsLogger,
      esClient,
      security,
      userProfile,
      getWorkflowsApi: () =>
        services.getService<WorkflowsServerPluginSetup['management']>('workflows.management'),
      getAttachmentsClient: (request) =>
        services
          .getService<AgentBuilderPluginStart>('agentBuilder')
          .attachments.getScopedClient({ request }),
    });

    const start: ProposalsPluginStart = {
      getProposalsService,
      getProposalPrivileges: () => privileges,
    };
    services.registerService('proposals', start);

    registerStepDefinitions({
      workflowsExtensions: registry,
      getProposalsService,
      resolveUser,
      privileges,
    });
  },
};
