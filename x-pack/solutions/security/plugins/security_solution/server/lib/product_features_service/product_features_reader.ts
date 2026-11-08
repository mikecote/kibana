/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ProductFeatureKeyType } from '@kbn/security-solution-features';
import { API_ACTION_PREFIX } from '@kbn/security-solution-features/actions';

export interface ProductFeaturesReader {
  isEnabled: (key: ProductFeatureKeyType) => boolean;
  isActionRegistered: (action: string) => boolean;
  getApiActionName: (apiPrivilege: string) => string;
}

export interface ProductFeaturesRuntimeSnapshot {
  enabledProductFeatureKeys: ProductFeatureKeyType[];
  registeredActions: string[];
}

/** Builds the product feature gates consumed by native Security services. */
export const createProductFeaturesReader = ({
  getEnabledFeatures,
  isActionRegistered,
}: {
  getEnabledFeatures: () => ReadonlySet<ProductFeatureKeyType> | undefined;
  isActionRegistered: ProductFeaturesReader['isActionRegistered'];
}): ProductFeaturesReader => ({
  isEnabled: (key) => {
    const enabled = getEnabledFeatures();
    if (!enabled) throw new Error('ProductFeatures has not yet been configured');
    return enabled.has(key);
  },
  isActionRegistered,
  getApiActionName: (apiPrivilege) => `api:${API_ACTION_PREFIX}${apiPrivilege}`,
});

/** Restores the authoritative product feature and action gates captured from Main. */
export const createNativeProductFeaturesReader = (
  snapshot: ProductFeaturesRuntimeSnapshot
): ProductFeaturesReader => {
  const enabled = new Set(snapshot.enabledProductFeatureKeys);
  const actions = new Set(snapshot.registeredActions);
  return createProductFeaturesReader({
    getEnabledFeatures: () => enabled,
    isActionRegistered: (action) => actions.has(action),
  });
};
