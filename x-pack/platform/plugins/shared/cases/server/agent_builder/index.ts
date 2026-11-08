/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, KibanaRequest } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-plugin/server';
import type { CasesClient } from '../client';
import type { CasesServerStartDependencies } from '../types';
import type { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { searchCasesToolWithServices } from './tools/search_cases';
import { manageCasesTool } from './tools/manage_cases';
import { getAttachmentsTool } from './tools/get_attachments_tool';
import { manageAttachmentsTool } from './tools/manage_attachments_tool';
import { observablesTool } from './tools/observable_tools';
import { findTemplatesTool } from './tools/find_templates_tool';
import { buildCasesSkill } from './skills/cases_skill';
import { casesAnalyticsSkill } from './skills/cases_analytics_skill';
import { createCaseAttachmentType } from './attachments/case_attachment_type';
import { createCasesAttachmentType } from './attachments/cases_attachment_type';
import { createCasesToolAvailabilityWithServices } from './utils/get_cases_tool_availability';

import { createCasesToolServices } from './cases_tool_services';
import type { CasesToolServices } from './cases_tool_services';

interface CasesAgentBuilderOptions {
  analyticsV2Enabled: boolean;
  attachmentsEnabled: boolean;
  templatesEnabled: boolean;
}

/**
 * Registers all Cases agent builder tools:
 *
 * 1. `platform.core.cases` — read/search (get by ID, bulk get, find similar, by alert IDs, search/filter)
 * 2. `platform.core.cases.manage` — create, update, delete, assign, unassign, add tags, set custom field
 * 3. `platform.core.cases.get_attachments` — get all attachments (read-only)
 * 4. `platform.core.cases.manage_attachments` — add comment/alerts/events/attachments (write)
 * 5. `platform.core.cases.observables` — add, update, delete observables
 * 6. `platform.core.cases.find_templates` — read-only, only when templates are enabled: look up
 *    case templates by name to resolve a `case_template_id`
 *
 * Also registers the `cases-management` skill, and — only when Cases-as-Data v2
 * is enabled — the `cases-analytics` skill (ES|QL analytics + visualizations over
 * the `.cases*` analytics indices). The analytics skill is gated on
 * `analyticsV2Enabled` because its indices don't exist otherwise.
 */
export function registerCasesAgentBuilderTools(
  agentBuilder: AgentBuilderPluginSetup,
  getCasesClient: (request: KibanaRequest) => Promise<CasesClient>,
  coreSetup: CoreSetup<CasesServerStartDependencies>,
  unifiedAttachmentTypeRegistry: UnifiedAttachmentTypeRegistry,
  options: CasesAgentBuilderOptions,
  logger: Logger
): void {
  registerCasesAgentBuilderToolsWithServices(
    agentBuilder,
    getCasesClient,
    createCasesToolServices(coreSetup),
    unifiedAttachmentTypeRegistry,
    options,
    logger
  );
}

/** Registers native Cases tools over explicit request, link and attachment services. */
export function registerCasesAgentBuilderToolsWithServices(
  agentBuilder: AgentBuilderPluginSetup,
  getCasesClient: (request: KibanaRequest) => Promise<CasesClient>,
  services: CasesToolServices,
  unifiedAttachmentTypeRegistry: UnifiedAttachmentTypeRegistry,
  { analyticsV2Enabled, attachmentsEnabled, templatesEnabled }: CasesAgentBuilderOptions,
  logger: Logger
): void {
  const availability = createCasesToolAvailabilityWithServices(services, logger);
  agentBuilder.tools.register({
    ...searchCasesToolWithServices(services, getCasesClient),
    availability,
  });
  agentBuilder.tools.register({
    ...manageCasesTool(getCasesClient, templatesEnabled),
    availability,
  });
  agentBuilder.tools.register({ ...getAttachmentsTool(getCasesClient), availability });
  agentBuilder.tools.register({
    ...manageAttachmentsTool(getCasesClient, unifiedAttachmentTypeRegistry, attachmentsEnabled),
    availability,
  });
  agentBuilder.tools.register({ ...observablesTool(getCasesClient), availability });
  // Only useful once templates are v2 saved objects that support name-based search; the legacy
  // per-space configuration templates have no such lookup.
  if (templatesEnabled) {
    agentBuilder.tools.register({ ...findTemplatesTool(getCasesClient), availability });
  }
  agentBuilder.skills.register({ ...buildCasesSkill(templatesEnabled), availability });
  // Only expose the analytics skill when the analytics indices exist.
  if (analyticsV2Enabled) {
    agentBuilder.skills.register({ ...casesAnalyticsSkill, availability });
  }
  agentBuilder.attachments.registerType(
    createCaseAttachmentType() as Parameters<typeof agentBuilder.attachments.registerType>[0]
  );
  agentBuilder.attachments.registerType(
    createCasesAttachmentType() as Parameters<typeof agentBuilder.attachments.registerType>[0]
  );
}
