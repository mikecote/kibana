/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTaskProcessInferenceFeatureRegistry } from './task_process_settings';
import type { InferenceFeatureConfig } from './types';

const parent: InferenceFeatureConfig = {
  featureId: 'parent',
  featureName: 'Parent',
  featureDescription: 'Parent feature',
  taskType: 'chat_completion',
  recommendedEndpoints: [],
};
const child: InferenceFeatureConfig = {
  ...parent,
  featureId: 'child',
  parentFeatureId: parent.featureId,
  recommendedEndpoints: ['current-endpoint'],
  ignoreGlobalDefault: true,
  allowTemplateRequiredModels: true,
};

describe('task process inference features', () => {
  const logger = loggingSystemMock.create().get();

  it('restores parent relationships, model policy and current recommendations', () => {
    const registry = createTaskProcessInferenceFeatureRegistry(
      { features: [parent, child] },
      logger
    );
    expect(registry.getAll()).toEqual([parent, child]);
  });

  it('uses the new dispatch snapshot without retaining features from the previous run', () => {
    const first = createTaskProcessInferenceFeatureRegistry({ features: [parent, child] }, logger);
    const next = createTaskProcessInferenceFeatureRegistry({ features: [parent] }, logger);
    expect(first.get('child')?.recommendedEndpoints).toEqual(['current-endpoint']);
    expect(next.get('child')).toBeUndefined();
  });

  it('fails explicitly if the snapshot is missing or cannot reproduce the registry', () => {
    expect(() => createTaskProcessInferenceFeatureRegistry(undefined, logger)).toThrow(
      'did not receive the inference feature registry'
    );
    expect(() => createTaskProcessInferenceFeatureRegistry({ features: [child] }, logger)).toThrow(
      'parentFeatureId'
    );
    expect(() =>
      createTaskProcessInferenceFeatureRegistry({ features: [parent, parent] }, logger)
    ).toThrow('already registered');
  });
});
