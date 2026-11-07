/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { InferenceFeatureRegistry } from './inference_feature_registry';
import type { InferenceFeatureConfig } from './types';

export const INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID = 'inferenceFeatures';

export interface InferenceFeaturesTaskProcessSettings {
  features: InferenceFeatureConfig[];
}

/** Restores Kibana's inference features and current endpoint recommendations for one execution. */
export const createTaskProcessInferenceFeatureRegistry = (
  settings: InferenceFeaturesTaskProcessSettings | undefined,
  logger: Logger
): InferenceFeatureRegistry => {
  if (!settings) throw new Error('The task process did not receive the inference feature registry');
  const registry = new InferenceFeatureRegistry(logger);
  // Kibana's registry preserves registration order, so parents precede their children.
  for (const feature of settings.features) {
    const result = registry.register(feature);
    if (!result.ok)
      throw new Error(`Cannot restore inference feature ${feature.featureId}: ${result.error}`);
  }
  return registry;
};
