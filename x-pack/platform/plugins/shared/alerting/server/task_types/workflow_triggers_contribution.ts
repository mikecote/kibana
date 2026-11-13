/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerTriggerDefinitions } from '../lib/workflow_extensions/register_trigger_definitions';

/**
 * The workflow triggers of alerting in the task process of the workflow task types, which finds the
 * workflows an event triggers by their definitions. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry) => registerTriggerDefinitions(registry),
};
