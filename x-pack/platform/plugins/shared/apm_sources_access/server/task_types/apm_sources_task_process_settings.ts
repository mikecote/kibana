/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { APMIndices } from '../../common/config_schema';

export const APM_SOURCES_TASK_PROCESS_SETTINGS_ID = 'apmSourcesAccessRuntime';

export interface ApmSourcesTaskProcessSettings {
  indices: APMIndices;
}
