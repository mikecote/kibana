/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/core/server';
import { registerImpactAttachment } from '../impact/attachments';
import { registerSubjectAttachment } from '../subjects/attachments';
import { registerHypothesesAttachment } from '../hypotheses/attachments';
import { createSetImpactTool } from '../impact/tools/set_impact_tool';
import { createSetHypothesesTool } from '../hypotheses/tools/set_hypotheses_tool';
import type { InvestigationsPrivilegesChecker } from '../investigations/services/check_investigations_privileges';
import type { AssertCanReadConversation } from '../investigation_attachments';
import type { InvestigationDocumentServices } from './create_document_services';
import type { ResolveUser } from './resolve_user';

export interface InvestigationAgentBuilderServices {
  getImpactService: () => InvestigationDocumentServices['impactService'];
  getSubjectsService: () => InvestigationDocumentServices['subjectsService'];
  getHypothesesService: () => InvestigationDocumentServices['hypothesesService'];
  resolveUser: ResolveUser;
  privileges: InvestigationsPrivilegesChecker;
  assertCanReadConversation: AssertCanReadConversation;
  logger: Logger;
}

/** Registers the native investigation tools and attachments with their scoped authorization checks. */
export const registerInvestigationAgentBuilder = (
  agentBuilder: AgentBuilderPluginSetup,
  {
    getImpactService,
    getSubjectsService,
    getHypothesesService,
    resolveUser,
    privileges,
    assertCanReadConversation,
    logger,
  }: InvestigationAgentBuilderServices
): void => {
  registerImpactAttachment(agentBuilder, {
    getImpactService,
    privileges,
    assertCanReadConversation,
    logger,
  });
  registerSubjectAttachment(agentBuilder, {
    getSubjectsService,
    privileges,
    assertCanReadConversation,
    logger,
  });
  registerHypothesesAttachment(agentBuilder, {
    getHypothesesService,
    privileges,
    assertCanReadConversation,
    logger,
  });

  agentBuilder.tools.register(
    createSetImpactTool({
      getImpactService,
      resolveUser,
      privileges,
      logger,
    })
  );
  agentBuilder.tools.register(
    createSetHypothesesTool({
      getHypothesesService,
      resolveUser,
      privileges,
      logger,
    })
  );
};
