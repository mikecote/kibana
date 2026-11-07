/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerSecurityWorkflowSteps } from '../workflows/register_security_workflow_steps';

/**
 * The workflow steps and triggers of the plugin, in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { logger }) => {
    registerSecurityWorkflowSteps(registry, {
      threatIntelLogger: logger.get('securitySolution', 'threatIntel'),
    });
  },
};
