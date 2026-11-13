/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BuildFlavor } from '@kbn/config/src/types';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';

import type { ConfigType } from './config';

export const SPACES_TASK_PROCESS_SETTINGS_ID = 'spacesRuntime';

export interface SpacesTaskProcessSettings {
  config: ConfigType;
  buildFlavor: BuildFlavor;
  features: KibanaFeatureConfig[];
  cpsEnabled: boolean;
}
