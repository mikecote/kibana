/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** The id of the plugin's settings in a task process, `host.settings[id]`. */
export const ALERTZERO_TASK_PROCESS_SETTINGS_ID = 'alertzero';

/**
 * What the steps read of the plugin in a task process: what Kibana knows when it dispatches the
 * run. Plain values, because they are sent over the wire.
 */
export interface AlertZeroTaskProcessSettings {
  /** `xpack.security.serviceAccounts.enabled`, which AlertZero needs to run its Workers. */
  serviceAccountsEnabled: boolean;
  /** Whether the plugin started its owner-bound managed workflows client (it needs service accounts and the plugins its Workers use). */
  managedWorkflowsReady: boolean;
  /** Whether telemetry is opted in right now. */
  telemetryOptedIn: boolean;
  /** Whether the dispatching plugin has the native inference feature endpoint service. */
  searchInferenceEndpointsAvailable: boolean;
}
