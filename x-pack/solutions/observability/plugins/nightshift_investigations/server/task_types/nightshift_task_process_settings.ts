/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** The id of the plugin's settings in a task process, `host.settings[id]`. */
export const NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID = 'nightshiftInvestigations';

/** What the steps read of the plugin in a task process. Plain values: they are sent over the wire. */
export interface NightshiftTaskProcessSettings {
  /** Kibana registers the steps only when the workflows management plugin is there. */
  workflowsManagementAvailable: boolean;
  decisionTreesEnabled: boolean;
  telemetryConnectorId?: string;
}

export const getNightshiftTaskProcessSettings = ({
  workflowsManagementAvailable,
  decisionTreesEnabled,
  telemetryConnectorId,
}: NightshiftTaskProcessSettings): NightshiftTaskProcessSettings => ({
  workflowsManagementAvailable,
  decisionTreesEnabled,
  ...(telemetryConnectorId ? { telemetryConnectorId } : {}),
});
