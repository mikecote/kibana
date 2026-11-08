/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  AgentBuilderContributionContext,
  AgentBuilderPluginStart,
} from '@kbn/agent-builder-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { ProposalsPluginStart } from '@kbn/proposals-plugin/server';
import {
  createProposalsRunServices,
  createProposalPrivilegesChecker,
} from '@kbn/proposals-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { AgenticInvestigationsPluginStart } from '../types';
import { createSubjectsClient } from '../subjects/services/subjects_client';
import { createInvestigationsClient } from '../investigations/services/investigations_client';
import { InvestigationsQueryService } from '../investigations/services/investigations_query_service';
import { InProgressResolver } from '../investigations/services/in_progress';
import { createConversationReadCheck } from '../investigation_attachments';
import { InvestigationStatusService } from '../investigations/services/investigation_status_service';
import { createInvestigationsPrivilegesChecker } from '../investigations/services/check_investigations_privileges';
import { createInvestigationDocumentServices } from '../services/create_document_services';
import type { InvestigationDocumentServices } from '../services/create_document_services';
import type { InvestigationAgentBuilderServices } from '../services/register_agent_builder';
import { createUserResolver } from '../services/resolve_user';
import {
  AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID,
  type AgenticInvestigationsTaskProcessSettings,
} from './agentic_investigations_task_process_settings';

export interface AgenticInvestigationsTaskProcessContext {
  host: AgentBuilderContributionContext['host'];
  settings: AgentBuilderContributionContext['settings'];
  logger: AgentBuilderContributionContext['logger'];
  services: Pick<
    AgentBuilderContributionContext['services'],
    'getAgentBuilderStart' | 'getWorkflowsManagement' | 'getService'
  >;
}

export interface AgenticInvestigationsTaskProcessServices
  extends InvestigationAgentBuilderServices {
  getConversationClient: AgentBuilderPluginStart['conversations']['getScopedClient'];
  getAttachmentClient: AgentBuilderPluginStart['attachments']['getScopedClient'];
  getInvestigationStatusService: () => InvestigationStatusService;
  getSubjectsClient: AgenticInvestigationsPluginStart['getSubjectsClient'];
  getInvestigationsClient: AgenticInvestigationsPluginStart['getInvestigationsClient'];
  getProposals: () => ProposalsPluginStart | undefined;
}

const runtimes = new WeakMap<TaskHost, AgenticInvestigationsTaskProcessServices>();

/** Resolves native investigation stores, attribution and authorization for this execution. */
export const getAgenticInvestigationsTaskProcessServices = (
  context: AgenticInvestigationsTaskProcessContext
): AgenticInvestigationsTaskProcessServices => {
  const host = context.host as TaskHost;
  const existing = runtimes.get(host);
  if (existing) return existing;
  const settings = context.settings[AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID] as
    | AgenticInvestigationsTaskProcessSettings
    | undefined;
  if (!settings) throw new Error('Agentic investigations requires its runtime settings');
  const { logger, services } = context;
  let documents: InvestigationDocumentServices | undefined;
  const getDocuments = () => {
    documents ??= createInvestigationDocumentServices({
      esClient: host.elasticsearch.asInternalUser,
      logger,
    });
    return documents;
  };
  const getSecurity = async () => {
    if (!settings.securityEnabled) return undefined;
    const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
    if (!security) throw new Error('Agentic investigations requires native Security');
    return security;
  };
  const privileges = createInvestigationsPrivilegesChecker({ getSecurity, logger });
  const getConversationClient: AgentBuilderPluginStart['conversations']['getScopedClient'] = (
    options
  ) => services.getAgentBuilderStart().conversations.getScopedClient(options);
  const getAttachmentClient: AgentBuilderPluginStart['attachments']['getScopedClient'] = (
    options
  ) => services.getAgentBuilderStart().attachments.getScopedClient(options);
  let proposals: ProposalsPluginStart | undefined;
  const getProposals = () => {
    if (!settings.proposalsEnabled) return undefined;
    if (proposals) return proposals;
    const { userProfile, security } = host;
    if (!userProfile) throw new Error('Proposals requires Core user profiles');
    const { getProposalsService } = createProposalsRunServices({
      logger,
      esClient: host.elasticsearch.asInternalUser,
      security,
      userProfile,
      getWorkflowsApi: () =>
        services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'],
      getAttachmentsClient: (request) => getAttachmentClient({ request }),
    });
    proposals = {
      getProposalsService,
      getProposalPrivileges: () => createProposalPrivilegesChecker({ getSecurity, logger }),
    };
    return proposals;
  };
  const getSpaceId = (
    request: Parameters<AgenticInvestigationsPluginStart['getSubjectsClient']>[0]
  ) =>
    settings.spacesEnabled
      ? services.getService<SpacesPluginStart>('spaces').spacesService.getSpaceId(request)
      : 'default';
  const resolveUser = (
    request: Parameters<AgenticInvestigationsPluginStart['getSubjectsClient']>[0]
  ) => {
    const { userProfile, security } = host;
    if (!userProfile) throw new Error('Agentic investigations requires Core user profiles');
    return createUserResolver({ userProfile, security, logger })(request);
  };
  let statusService: InvestigationStatusService | undefined;
  let queryService: InvestigationsQueryService | undefined;
  const getQueryService = (): InvestigationsQueryService => {
    queryService ??= new InvestigationsQueryService({
      getConversationClient: (request) => getConversationClient({ request }),
      getSpaceId,
      getImpactService: () => getDocuments().impactService,
      getSubjectsService: () => getDocuments().subjectsService,
      getHypothesesService: () => getDocuments().hypothesesService,
      getProposals,
      inProgress: new InProgressResolver({
        getWorkflowsManagement: () =>
          services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'],
        getProposals,
        logger,
      }),
      logger,
    });
    return queryService;
  };
  const runtime: AgenticInvestigationsTaskProcessServices = {
    getConversationClient,
    getAttachmentClient,
    getProposals,
    getSubjectsClient: createSubjectsClient({
      getSubjectsService: () => getDocuments().subjectsService,
      getSpaceId,
      privileges,
      resolveUser,
      getConversationClient: (request) => getConversationClient({ request }),
      getAttachmentClient: (request) => getAttachmentClient({ request }),
    }),
    getInvestigationsClient: createInvestigationsClient({
      getQueryService,
      getSpaceId,
      privileges,
      deleteAllInSpace: async (spaceId) => {
        const { subjectsService, impactService, hypothesesService } = getDocuments();
        const { subjects, claims } = await subjectsService.deleteAllInSpace(spaceId);
        const impact = await impactService.getDocumentService().deleteAllInSpace(spaceId);
        const hypotheses = await hypothesesService.getDocumentService().deleteAllInSpace(spaceId);
        return { subjects, subjectClaims: claims, impact, hypotheses };
      },
    }),
    getInvestigationStatusService: () => {
      statusService ??= new InvestigationStatusService({
        getConversationClient: (request) => getConversationClient({ request }),
        getProposals,
        getSpaceId,
        logger,
      });
      return statusService;
    },
    getImpactService: () => getDocuments().impactService,
    getSubjectsService: () => getDocuments().subjectsService,
    getHypothesesService: () => getDocuments().hypothesesService,
    resolveUser,
    privileges,
    assertCanReadConversation: createConversationReadCheck({
      getConversationClient: (request) =>
        services.getAgentBuilderStart().conversations.getScopedClient({ request }),
    }),
    logger,
  };
  runtimes.set(host, runtime);
  return runtime;
};
