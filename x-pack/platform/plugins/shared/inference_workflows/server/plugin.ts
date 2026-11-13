/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin } from '@kbn/core/server';
import type { InferenceWorkflowsSetupDeps, InferenceWorkflowsStartDeps } from './types';
import { registerAiWorkflowSteps } from './steps/ai/register_ai_workflow_steps';
import { registerInferenceFeatures } from './steps/ai/register_inference_features';

export class InferenceWorkflowsPlugin
  implements Plugin<{}, {}, InferenceWorkflowsSetupDeps, InferenceWorkflowsStartDeps>
{
  setup(core: CoreSetup<InferenceWorkflowsStartDeps>, deps: InferenceWorkflowsSetupDeps) {
    registerAiWorkflowSteps(deps.workflowsExtensions, async () => {
      const [, { inference, searchInferenceEndpoints }] = await core.getStartServices();
      return { inference, searchInferenceEndpoints };
    });

    registerInferenceFeatures(deps.searchInferenceEndpoints);

    return {};
  }

  start(_core: CoreStart) {
    return {};
  }
}
