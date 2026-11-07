/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerSignificantEventsWorkflowSteps } from '../workflows/register_significant_events_workflow_steps';

/**
 * The workflow steps and triggers of the plugin, in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The model the step
 * resolves reads the ui settings the AI settings define, which the `ai.*` steps of the inference
 * workflows plugin contribute to the same process.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, logger, services }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const { elasticsearch, savedObjects, uiSettings } = host as TaskHost;
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    let inference: InferenceServerStart | undefined;
    registerSignificantEventsWorkflowSteps(registry, {
      getInference: () =>
        (inference ??= createInferenceTaskProcessServices({
          core: { elasticsearch, savedObjects, uiSettings },
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        })),
      getSavedObjects: () => savedObjects,
      getUiSettings: () => uiSettings,
      logger: logger.get('resolve_model'),
    });
  },
};
