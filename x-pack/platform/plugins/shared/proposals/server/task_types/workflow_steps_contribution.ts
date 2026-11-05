/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import { CloneProposalStepId, CreateProposalStepId } from '@kbn/proposals-common';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createWorkflowsReadApi } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type { WorkflowAccessCore } from '@kbn/workflows-management-plugin/server/services/workflow_access_control';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createProposalPrivilegesChecker } from '../services/check_proposal_privileges';
import { ProposalsService } from '../services/proposals_service';
import { createProposalUserResolver } from '../services/resolve_proposal_user';
import { registerStepDefinitions } from '../step_types';
import { createProposalsStorageClient } from '../storage/proposals_storage';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/**
 * The proposal steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The service is built with the class
 * Kibana builds: its storage over the internal client, the read API of the workflows management
 * plugin over the engine's execution storage, and the privilege checks of the security task plugin.
 *
 * Creating or cloning a proposal attaches a card to its conversation with Agent Builder's
 * attachments, which a process does not have: a workflow that uses either step is declined, and
 * Kibana runs it.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, logger, services, registerRunCheck }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const { elasticsearch, security, userProfile, plugins } = host as TaskHost & {
      userProfile?: CoreStart['userProfile'];
    };
    const authz = plugins?.security as Pick<SecurityPluginStart, 'authz'> | undefined;
    if (!userProfile)
      throw new Error('The task process host did not lend Core user profile service');
    if (!authz) throw new Error('The task process did not get the security plugin');

    const proposalsLogger = logger.get('proposals');
    const esClient = elasticsearch.asInternalUser;
    const privileges = createProposalPrivilegesChecker({
      getSecurity: async () => authz as SecurityPluginStart,
      logger: proposalsLogger,
    });
    const resolveUser = createProposalUserResolver({
      userProfile,
      security: security as CoreStart['security'],
      logger: proposalsLogger,
    });

    let service: ProposalsService | undefined;
    const getProposalsService = () => {
      if (!service) {
        const readApi = createWorkflowsReadApi({
          logger: proposalsLogger,
          esClient,
          core: {
            security,
            userProfile,
            elasticsearch: { client: elasticsearch },
          } as unknown as WorkflowAccessCore,
          authz: authz.authz,
          workflowExecutionsDataClient:
            services.executionDataClients.createWorkflowDataClient() as never,
          stepExecutionsDataClient: services.executionDataClients.createStepDataClient() as never,
        });
        service = new ProposalsService({
          storage: createProposalsStorageClient({ esClient, logger: proposalsLogger }),
          logger: proposalsLogger,
          getWorkflowsApi: () => ({
            getWorkflow: readApi.getWorkflow,
            getWorkflowExecution: readApi.getWorkflowExecution,
            getWorkflowExecutionStatuses: readApi.getWorkflowExecutionStatuses,
            resumeWorkflowExecution: onlyInKibana('Resuming a workflow execution') as never,
          }),
          getAttachmentsClient: onlyInKibana('Attaching a proposal to a conversation') as never,
        });
      }
      return service;
    };

    registerRunCheck?.((step) =>
      step.type === CreateProposalStepId || step.type === CloneProposalStepId
        ? 'attaching the proposal to its conversation needs Agent Builder, which a task process does not have'
        : undefined
    );
    registerStepDefinitions({
      workflowsExtensions: registry,
      getProposalsService,
      resolveUser,
      privileges,
    });
  },
};
