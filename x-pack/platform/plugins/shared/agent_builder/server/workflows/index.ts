/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  WorkflowsExtensionsServerPluginSetup,
  WorkflowStepsRegistry,
} from '@kbn/workflows-extensions/server';
import { rerankStepDefinition } from '../step_types/rerank_step';
import { conversationStepRegistry, type ConversationStepDeps } from './registry';
import { attachmentStepRegistry, type AttachmentStepDeps } from './attachment_registry';
import {
  conversationMetadataUpdatedTriggerCommonDefinition,
  conversationUpdatedTriggerCommonDefinition,
  attachmentTriggerCommonDefinitions,
} from '../../common/workflows/triggers';

/**
 * The triggers and the steps that need nothing of the plugin's services: used by `plugin.ts` and by
 * the contribution to the task process of the workflow task types. The other steps (conversations,
 * attachments and `runAgent`) read registries that other plugins fill in their `setup()` (agents,
 * attachment types, tools, skills) and are only registered in Kibana.
 */
export function registerAgentBuilderProcessWorkflowDefinitions(registry: WorkflowStepsRegistry) {
  registry.registerTriggerDefinition(conversationMetadataUpdatedTriggerCommonDefinition);
  registry.registerTriggerDefinition(conversationUpdatedTriggerCommonDefinition);
  for (const definition of attachmentTriggerCommonDefinitions) {
    registry.registerTriggerDefinition(definition);
  }
  registry.registerStepDefinition(rerankStepDefinition);
}

export function registerConversationWorkflowSteps(
  workflowsExtensions: Pick<WorkflowsExtensionsServerPluginSetup, 'registerStepDefinition'>,
  deps: ConversationStepDeps
) {
  for (const factory of conversationStepRegistry) {
    workflowsExtensions.registerStepDefinition(factory(deps));
  }
}

export function registerAttachmentWorkflowSteps(
  workflowsExtensions: Pick<WorkflowsExtensionsServerPluginSetup, 'registerStepDefinition'>,
  deps: AttachmentStepDeps
) {
  for (const factory of attachmentStepRegistry) {
    workflowsExtensions.registerStepDefinition(factory(deps));
  }
}
