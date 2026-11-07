/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FeaturesPluginSetup } from '@kbn/features-plugin/server';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { getRegisteredRuleType } from '../lib/get_registered_rule_type';
import type { AlertIndicesRuleTypeRegistry } from '../lib/create_get_alert_indices_alias';

export const ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID = 'alertingAuthorizationRuntime';

export type AlertingAuthorizationRuleTypeSnapshot = {
  id: string;
} & ReturnType<AlertIndicesRuleTypeRegistry['get']>;

export interface AlertingAuthorizationTaskProcessSettings {
  ruleTypes: AlertingAuthorizationRuleTypeSnapshot[];
  features: KibanaFeatureConfig[];
  spacesEnabled: boolean;
  securityEnabled: boolean;
}

/** Captures the live native registry and feature metadata needed to authorize alert access. */
export const getAlertingAuthorizationTaskProcessSettings = ({
  ruleTypeRegistry,
  features,
  ...availability
}: {
  ruleTypeRegistry: { list: () => ReadonlyMap<string, AlertingAuthorizationRuleTypeSnapshot> };
  features: Pick<FeaturesPluginSetup, 'getKibanaFeatures'>;
  spacesEnabled: boolean;
  securityEnabled: boolean;
}): AlertingAuthorizationTaskProcessSettings => ({
  ...availability,
  ruleTypes: [...ruleTypeRegistry.list().values()].map(({ id, alerts }) => ({
    id,
    ...(alerts ? { alerts: { context: alerts.context, isSpaceAware: alerts.isSpaceAware } } : {}),
  })),
  features: features.getKibanaFeatures().map((feature) => feature.toRaw()),
});

export interface AlertingAuthorizationRegistry {
  getAllTypes: () => string[];
  has: (id: string) => boolean;
  get: (id: string) => AlertingAuthorizationRuleTypeSnapshot;
  list: () => ReadonlyMap<string, AlertingAuthorizationRuleTypeSnapshot>;
}

/** Restores the captured registry through the native metadata lookup used by alert authorization. */
export const createAlertingAuthorizationRegistry = (
  snapshot: AlertingAuthorizationTaskProcessSettings
): AlertingAuthorizationRegistry => {
  const registry = new Map(
    snapshot.ruleTypes.map((descriptor) => [
      descriptor.id,
      { ...descriptor, ...(descriptor.alerts ? { alerts: { ...descriptor.alerts } } : {}) },
    ])
  );
  return {
    getAllTypes: () => [...registry.keys()],
    has: (id) => registry.has(id),
    get: (id) => getRegisteredRuleType(registry, id),
    list: () => new Map(registry),
  };
};
