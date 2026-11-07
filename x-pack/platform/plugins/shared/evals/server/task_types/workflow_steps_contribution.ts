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
import type { TaskProviderRegistry } from '../task_providers/types';
import { createTaskProviderRegistry } from '../task_providers/registry';
import { checkEvalsTaskProvider } from '../workflows/check_task_provider';
import { registerEvalsWorkflowSteps } from '../workflows';

/**
 * The evals workflow steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps call Kibana's API with the
 * run's credential (`callKibanaApi`) and the inference services built from the host. The task
 * providers come from the same registry as Kibana, extended by executable workflow contributions.
 * The dispatch snapshot checks that every provider Kibana registered is available in this run.
 */
export const EVALS_TASK_PROVIDERS_SETTINGS_ID = 'evalsTaskProviders';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [EVALS_TASK_PROVIDERS_SETTINGS_ID] },
  provides: { 'evals.taskProviders': () => createTaskProviderRegistry() },
  register: (registry, { host, logger, services, settings, registerRunCheck }) => {
    const snapshot = settings[EVALS_TASK_PROVIDERS_SETTINGS_ID] as { names: string[] } | undefined;
    if (!snapshot) return;
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const { elasticsearch, savedObjects, uiSettings } = host as TaskHost;
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    const taskProviderRegistry = services.getService<TaskProviderRegistry>('evals.taskProviders');
    let inference: InferenceServerStart | undefined;

    registerRunCheck?.((step) => {
      if (!step.type.startsWith('ai.evals.')) return;
      const actual = taskProviderRegistry.list().map(({ name }) => name);
      const missing = snapshot.names.filter((name) => !actual.includes(name));
      const extra = actual.filter((name) => !snapshot.names.includes(name));
      if (missing.length || extra.length) {
        return `Evals task providers differ from Kibana: missing [${missing.join(
          ', '
        )}], extra [${extra.join(', ')}]`;
      }
      return checkEvalsTaskProvider(step, taskProviderRegistry.has);
    });
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
