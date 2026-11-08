/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import { API_ACTION_PREFIX } from '@kbn/security-solution-features/actions';
import { createProductFeaturesServiceMock } from './mocks';
import {
  createNativeProductFeaturesReader,
  createProductFeaturesReader,
} from './product_features_reader';

it('preserves the unconfigured Main gate and reads the current enabled features', () => {
  let enabled: ReadonlySet<typeof ProductFeatureKey.graphVisualization> | undefined;
  const reader = createProductFeaturesReader({
    getEnabledFeatures: () => enabled,
    isActionRegistered: () => false,
  });
  expect(() => reader.isEnabled(ProductFeatureKey.graphVisualization)).toThrow(
    'has not yet been configured'
  );
  enabled = new Set([ProductFeatureKey.graphVisualization]);
  expect(reader.isEnabled(ProductFeatureKey.graphVisualization)).toBe(true);
  enabled = new Set();
  expect(reader.isEnabled(ProductFeatureKey.graphVisualization)).toBe(false);
});

it('restores Main gates from dispatch metadata without sharing mutable registrations', () => {
  const main = createProductFeaturesServiceMock([ProductFeatureKey.graphVisualization]);
  const snapshot = main.getRuntimeSnapshot();
  const action = main.getApiActionName('read');
  snapshot.registeredActions.push(action);
  const native = createNativeProductFeaturesReader(structuredClone(snapshot));
  expect(native.isEnabled(ProductFeatureKey.graphVisualization)).toBe(
    main.isEnabled(ProductFeatureKey.graphVisualization)
  );
  expect(native.getApiActionName('read')).toBe(`api:${API_ACTION_PREFIX}read`);
  expect(native.isActionRegistered(action)).toBe(true);
  expect(native.isActionRegistered('api:not-registered')).toBe(false);
  snapshot.enabledProductFeatureKeys.length = 0;
  snapshot.registeredActions.length = 0;
  expect(native.isEnabled(ProductFeatureKey.graphVisualization)).toBe(true);
  expect(native.isActionRegistered(action)).toBe(true);
  expect(main.getRuntimeSnapshot().enabledProductFeatureKeys).toContain(
    ProductFeatureKey.graphVisualization
  );
  const next = createNativeProductFeaturesReader(
    createProductFeaturesServiceMock([]).getRuntimeSnapshot()
  );
  expect(next.isEnabled(ProductFeatureKey.graphVisualization)).toBe(false);
});
