/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerThreatIntelWorkflowSteps } from '../threat_intel/workflows/step_types';
import { registerWorkflowSteps } from './step_types';
import { registerSecurityWorkflowTriggers } from './triggers';

export interface SecurityWorkflowStepsServices {
  /**
   * The logger of `threat_intel.fetch_source`, which is registered when given. Kibana registers it
   * where it decides whether the threat intelligence supply is on, a task process always has it.
   */
  threatIntelLogger?: Logger;
}

/**
 * Registers the workflow steps and triggers of the plugin. The steps are module constants that read
 * everything through the context of the engine, so Kibana (`plugin.ts`) and a task process (the
 * `workflow-steps` contribution) register the same definitions through this function.
 */
export const registerSecurityWorkflowSteps = (
  registry: WorkflowStepsRegistry,
  services: SecurityWorkflowStepsServices = {}
): void => {
  registerWorkflowSteps(registry);
  registerSecurityWorkflowTriggers(registry);
  if (services.threatIntelLogger) {
    registerThreatIntelWorkflowSteps({
      workflowsExtensions: registry,
      logger: services.threatIntelLogger,
    });
  }
};
