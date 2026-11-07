/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, ElasticsearchClient, Logger } from '@kbn/core/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { ProposalsService } from '../services/proposals_service';
import type { ProposalsServiceDeps } from '../services/proposals_service';
import { createProposalUserResolver } from '../services/resolve_proposal_user';
import type { ResolveProposalUser } from '../services/resolve_proposal_user';
import { createProposalsStorageClient } from '../storage/proposals_storage';

export interface ProposalsRunServicesDeps {
  logger: Logger;
  /** The internal user client. */
  esClient: ElasticsearchClient;
  security: CoreStart['security'];
  userProfile: CoreStart['userProfile'];
  getWorkflowsApi: () => WorkflowsServerPluginSetup['management'];
  getAttachmentsClient: ProposalsServiceDeps['getAttachmentsClient'];
}

export interface ProposalsRunServices {
  resolveUser: ResolveProposalUser;
  getProposalsService: () => ProposalsService;
}

/**
 * What the proposals registrations read, built from explicit dependencies: the user resolver and the
 * service over its storage (the privilege checks are built by `createProposalPrivilegesChecker`). Built by a task process from its host; `plugin.ts`
 * builds the same classes from the start contracts.
 */
export const createProposalsRunServices = ({
  logger,
  esClient,
  security,
  userProfile,
  getWorkflowsApi,
  getAttachmentsClient,
}: ProposalsRunServicesDeps): ProposalsRunServices => {
  const resolveUser = createProposalUserResolver({ userProfile, security, logger });
  let service: ProposalsService | undefined;
  const getProposalsService = () => {
    if (!service) {
      service = new ProposalsService({
        storage: createProposalsStorageClient({ esClient, logger }),
        logger,
        getWorkflowsApi,
        getAttachmentsClient,
      });
    }
    return service;
  };
  return { resolveUser, getProposalsService };
};
