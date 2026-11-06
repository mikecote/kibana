/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { StaticToolRegistration } from '@kbn/agent-builder-server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { productDocumentationTool } from './product_documentation';
import { integrationKnowledgeTool } from './integration_knowledge';
import type { AgentBuilderPlatformCoreSetup } from '../types';
import { getDocumentByIdTool } from './get_document_by_id';
import { getIndexMappingsTool } from './get_index_mapping';
import { listIndicesTool } from './list_indices';
import { indexExplorerTool } from './index_explorer';
import { generateEsqlTool } from './generate_esql';
import { executeEsqlTool } from './execute_esql';
import { searchTool } from './search';

export const registerTools = ({
  coreSetup,
  agentBuilder,
  organizationId,
  productDocumentation,
}: {
  coreSetup: AgentBuilderPlatformCoreSetup;
  agentBuilder: AgentBuilderPluginSetup;
  organizationId?: string;
  /** Whether the LLM tasks plugin is there: the product documentation tool is only registered with it. */
  productDocumentation: boolean;
}) => {
  const tools: Array<StaticToolRegistration<any>> = [
    searchTool({ coreSetup, topSnippetsDefaults: agentBuilder.topSnippets }),
    getDocumentByIdTool(),
    executeEsqlTool(),
    generateEsqlTool({ organizationId }),
    getIndexMappingsTool(),
    listIndicesTool(),
    indexExplorerTool(),
    ...(productDocumentation ? [productDocumentationTool(coreSetup)] : []),
    integrationKnowledgeTool(coreSetup),
  ];

  tools.forEach((tool) => {
    agentBuilder.tools.register(tool);
  });
};
