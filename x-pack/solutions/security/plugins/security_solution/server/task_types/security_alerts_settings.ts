/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BuildFlavor } from '@kbn/config';

export const SECURITY_ALERTS_SETTINGS_ID = 'securityAlerts';

export interface SecurityAlertsTaskProcessSettings {
  searchIndexName?: string;
  signalsIndex: string;
  appClientInitialized: boolean;
  kibanaBranch: string;
  buildFlavor: BuildFlavor;
  workflowEventsAvailable: boolean;
}
