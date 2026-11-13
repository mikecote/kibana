/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import {
  resolveModelStepDefinition,
  type ResolveModelStepServices,
} from '../step_definitions/resolve_model';
import { registerSignificantEventsWorkflowTriggers } from './triggers/register_triggers';

export interface SignificantEventsWorkflowStepsServices extends ResolveModelStepServices {
  logger: Logger;
}

/**
 * Registers the workflow steps and triggers of the plugin, in Kibana (`plugin.ts`) and in a task
 * process (the `workflow-steps` contribution). The step reads inference, saved objects and ui
 * settings through the getters when it runs.
 */
export const registerSignificantEventsWorkflowSteps = (
  registry: WorkflowStepsRegistry,
  services: SignificantEventsWorkflowStepsServices
): void => {
  registry.registerStepDefinition(resolveModelStepDefinition(services));
  // Custom event-driven triggers users can subscribe to from their own workflows.
  registerSignificantEventsWorkflowTriggers(registry);
};
