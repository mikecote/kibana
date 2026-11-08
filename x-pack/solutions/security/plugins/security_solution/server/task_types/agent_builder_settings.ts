/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { ConfigType } from '../config';
import type { ProductFeaturesRuntimeSnapshot } from '../lib/product_features_service';

export const SECURITY_AGENT_BUILDER_SETTINGS_ID = 'securitySolutionAgentBuilder';

export interface SecurityAgentBuilderSettings {
  config: ConfigType;
  productFeatures: ProductFeaturesRuntimeSnapshot;
  cloud?: Pick<CloudSetup, 'isCloudEnabled' | 'isServerlessEnabled'>;
  telemetryOptIn?: boolean;
  isServerless: boolean;
  canEncrypt: boolean;
  cpsAvailable: boolean;
  plugins: {
    ml: boolean;
    security: boolean;
    osquery: boolean;
    llmTasks?: boolean;
    fleet?: boolean;
    mitreAttack?: boolean;
  };
}
