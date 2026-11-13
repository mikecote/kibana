/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { significantEventsTriggerCommonDefinitions } from '../../../common/workflows/triggers';

export const registerSignificantEventsWorkflowTriggers = (
  workflowsExtensions: WorkflowStepsRegistry | undefined
): void => {
  if (!workflowsExtensions) {
    return;
  }

  significantEventsTriggerCommonDefinitions.forEach((definition) => {
    workflowsExtensions.registerTriggerDefinition(definition);
  });
};
