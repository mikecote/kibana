/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';

export const RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID = 'ruleDataViewsCapabilities';

export interface RuleDataViewsCapabilitiesSettings {
  features: KibanaFeatureConfig[];
  spacesEnabled: boolean;
}
