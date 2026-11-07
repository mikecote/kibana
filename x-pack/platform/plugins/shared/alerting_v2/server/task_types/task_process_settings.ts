/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { PluginConfig } from '../config';

export const ALERTING_V2_TASK_PROCESS_SETTINGS_ID = 'alertingV2Runtime';

export interface AlertingV2TaskProcessSettings {
  config: PluginConfig;
  projectType?: CloudSetup['serverless']['projectType'];
  agentBuilderEnabled: boolean;
  smlEnabled: boolean;
}
