/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import type { GetInferenceStepServices } from '../../types';
import { aiClassifyStepDefinition } from './ai_classify_step/step';
import { aiPromptStepDefinition } from './ai_prompt_step/step';
import { aiSummarizeStepDefinition } from './ai_summarize_step/step';

/**
 * Registers the `ai.*` workflow steps, in Kibana (`plugin.ts`) and in a task process (the
 * `workflow-steps` contribution). The steps read the inference services through `getServices` when
 * they run, so neither caller hands them plugin state.
 */
export const registerAiWorkflowSteps = (
  registry: WorkflowStepsRegistry,
  getServices: GetInferenceStepServices
): void => {
  registry.registerStepDefinition(aiPromptStepDefinition(getServices));
  registry.registerStepDefinition(aiSummarizeStepDefinition(getServices));
  registry.registerStepDefinition(aiClassifyStepDefinition(getServices));
};
