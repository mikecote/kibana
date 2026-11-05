/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getAnonymizationUiSettings } from '@kbn/ai-anonymization-server';
import { getGenAiUiSettings } from '@kbn/gen-ai-settings-plugin/server/ui_settings';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import { createSearchInferenceEndpointsStart } from '@kbn/search-inference-endpoints/server/create_search_inference_endpoints_start';
import { InferenceFeatureRegistry } from '@kbn/search-inference-endpoints/server/inference_feature_registry';
import { createInferenceSettingsSavedObjectType } from '@kbn/search-inference-endpoints/server/saved_objects/inference_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type {
  WorkflowStepsContribution,
  WorkflowStepsContributionServices,
} from '@kbn/workflows-extensions/server';
import { checkConnectorFeatures } from './check_connector_features';
import { registerInferenceFeatures } from '../steps/ai/register_inference_features';
import { registerAiWorkflowSteps } from '../steps/ai/register_ai_workflow_steps';
import type { InferenceStepServices } from '../types';

// The default connector setting reads the actions client of the run's request, which exists once the
// process has built the actions runtime and handed it to `register`.
let getActionsClientWithRequest: WorkflowStepsContributionServices['getActionsClientWithRequest'];

/**
 * The `ai.*` workflow steps, in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The inference services the steps read
 * are the ones the inference and search inference endpoints plugins build their start contracts
 * with, from the host and the actions client of the run.
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    savedObjectTypes: [createInferenceSettingsSavedObjectType()],
    uiSettings: [
      getGenAiUiSettings(
        (request) =>
          getActionsClientWithRequest(request) as ReturnType<
            Parameters<typeof getGenAiUiSettings>[0]
          >
      ),
      getAnonymizationUiSettings(),
    ],
  },
  register: (registry, { host, logger, services, registerRunCheck }) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    getActionsClientWithRequest = services.getActionsClientWithRequest;
    const { elasticsearch, savedObjects, uiSettings } = host as TaskHost;
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    const features = new InferenceFeatureRegistry(logger.get('inferenceFeatures'));
    registerInferenceFeatures({ features });
    registerRunCheck?.((step) =>
      checkConnectorFeatures(step.config, (featureId) => features.get(featureId) !== undefined)
    );

    let services$: InferenceStepServices | undefined;
    const getServices = async (): Promise<InferenceStepServices> => {
      if (!services$) {
        const core = { elasticsearch, savedObjects, uiSettings };
        const inference = createInferenceTaskProcessServices({
          core,
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        });
        services$ = {
          inference,
          searchInferenceEndpoints: createSearchInferenceEndpointsStart({
            core,
            inference,
            featureRegistry: features,
            logger: logger.get('searchInferenceEndpoints'),
          }),
        };
      }
      return services$;
    };

    registerAiWorkflowSteps(registry, getServices);
  },
};
