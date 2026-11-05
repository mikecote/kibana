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
import { createTaskProviderRegistry } from '../task_providers/registry';
import { checkEvalsTaskProvider } from '../workflows/check_task_provider';
import { registerEvalsWorkflowSteps } from '../workflows';

/**
 * The evals workflow steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps call Kibana's API with the
 * run's credential (`callKibanaApi`) and the inference services built from the host. The task
 * provider registry is the built-in providers, built for each process: a step that names a provider
 * a suite registered with the plugin in Kibana is declined. The ui settings the inference services
 * read are the ones the inference workflows plugin contributes to the same process.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, logger, services, registerRunCheck }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const { elasticsearch, savedObjects, uiSettings } = host as TaskHost;
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    const taskProviderRegistry = createTaskProviderRegistry();
    let inference: InferenceServerStart | undefined;

    registerRunCheck?.((step) => checkEvalsTaskProvider(step, taskProviderRegistry.has));
    registerEvalsWorkflowSteps(registry, {
      logger: logger.get('evals'),
      taskProviderRegistry,
      getInferenceStart: async () =>
        (inference ??= createInferenceTaskProcessServices({
          core: { elasticsearch, savedObjects, uiSettings },
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        })),
    });
  },
};
