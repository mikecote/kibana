/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { MetricsDataClient } from '../client';

export const METRICS_DATA_TASK_PROCESS_SETTINGS_ID = 'metricsDataAccessRuntime';

export interface MetricsDataDefaultHandlerRegistration {
  installed: boolean;
  owner?: string;
}

export interface MetricsDataTaskProcessSettings {
  defaultHandler: MetricsDataDefaultHandlerRegistration;
}

export interface MetricsDataDefaultIndicesProvider {
  configure: (client: MetricsDataClient) => void;
}
