/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SearchTaskProcessSettings } from '@kbn/data-plugin/server/search/types';

/** The id under which the alerting plugin sends how its rule runs differ by configuration. */
export const ALERTING_RUN_SETTINGS_ID = 'alertingRun';

/**
 * What a task process of a rule type is sent besides the configs of alerting and actions: what Kibana
 * decides while it starts from the plugins around alerting, which a process cannot see.
 */
export interface AlertingRunSettings {
  /**
   * Whether the maintenance windows plugin is enabled (`xpack.maintenanceWindows.enabled`). Without
   * it Kibana applies no maintenance window to a rule run.
   */
  maintenanceWindowsEnabled: boolean;
  dataViews: {
    /** `data_views.scriptedFieldsEnabled`, which is off by default in serverless. */
    scriptedFieldsEnabled: boolean;
  };
  /** The `data.search` config, the Elasticsearch timeouts and whether rollups are enabled. */
  search?: SearchTaskProcessSettings;
}

/** What a process falls back to when it is not sent the settings (a remote process without them). */
export const DEFAULT_ALERTING_RUN_SETTINGS: AlertingRunSettings = {
  maintenanceWindowsEnabled: true,
  dataViews: { scriptedFieldsEnabled: true },
};
