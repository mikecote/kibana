/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import type { FeedbackAnalysisStepDependencies, KiStepDependencies } from './helpers';
import type { VerifyKi } from './verify_ki';
import { getCreateKiStepDefinition } from './create_ki';
import { getUpdateKiStepDefinition } from './update_ki';
import { getDeleteKiStepDefinition } from './delete_ki';
import { getFeedbackContextStepDefinition } from './feedback_context';
import { getRecordImprovementsStepDefinition } from './record_improvements';
import { createVerifyKiStepDefinition } from './verify_ki_step';

/**
 * Registers the KI and feedback analysis workflow steps. Kibana and the task process of the workflow
 * task types register them with this function; a process has no `feedbackAnalysis` (see
 * `task_types/workflow_steps_contribution.ts`) and the feedback analysis steps are then not registered.
 */
export const registerStepDefinitions = ({
  workflowsExtensions,
  feedbackAnalysis,
  verifyKi,
  ...deps
}: KiStepDependencies & {
  workflowsExtensions: WorkflowStepsRegistry;
  feedbackAnalysis?: FeedbackAnalysisStepDependencies;
  verifyKi: VerifyKi;
}): void => {
  workflowsExtensions.registerStepDefinition(
    createVerifyKiStepDefinition(deps.isContextEngineEnabled, verifyKi)
  );
  workflowsExtensions.registerStepDefinition(getCreateKiStepDefinition({ ...deps, verifyKi }));
  workflowsExtensions.registerStepDefinition(getUpdateKiStepDefinition(deps));
  workflowsExtensions.registerStepDefinition(getDeleteKiStepDefinition(deps));
  if (feedbackAnalysis) {
    workflowsExtensions.registerStepDefinition(getFeedbackContextStepDefinition(feedbackAnalysis));
    workflowsExtensions.registerStepDefinition(
      getRecordImprovementsStepDefinition(feedbackAnalysis)
    );
  }
};
