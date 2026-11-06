/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AlertingServerSetup } from '@kbn/alerting-plugin/server';
import type { ObservabilityPluginSetup } from '@kbn/observability-plugin/server';
import type { SyntheticsServerSetup } from '../types';
import type { ServiceLocationsServer } from '../synthetics_service/get_service_locations';
import type { LocationsClient } from '../synthetics_service/get_all_locations';

/**
 * What the synthetics rule types read of the plugin's server, so Kibana (the whole server) and a task
 * process (what it has of it) build them the same way.
 */
export type SyntheticsRuleServer = Pick<
  SyntheticsServerSetup,
  'logger' | 'basePath' | 'isCpsEnabled'
> &
  ServiceLocationsServer & {
    encryptedSavedObjects: Pick<SyntheticsServerSetup['encryptedSavedObjects'], 'getClient'>;
  };

/** What the synthetics rule types read of the plugins they are registered with. */
export interface SyntheticsRulePlugins {
  alerting: Pick<AlertingServerSetup, 'registerType'>;
  observability: Pick<ObservabilityPluginSetup, 'getAlertDetailsConfig'>;
}

/** What the synthetics rule types read of the monitor client: where locations come from. */
export type SyntheticsRuleMonitorClient = LocationsClient;

/**
 * What Kibana sends to a task process (`registerTaskProcessSettings('synthetics', ...)`) for the
 * rules to build their server from: only what they read, not the whole config, which holds the
 * credentials of the Synthetics service.
 */
export interface SyntheticsTaskProcessSettings {
  service: ServiceLocationsServer['config']['service'];
  isCpsEnabled: boolean;
  /**
   * The public locations and access status of the Synthetics service as Kibana has them now, which
   * its sync task refreshes. A rule that filters by location reads them to resolve the location.
   */
  serviceManagedLocations?: Pick<
    SyntheticsRuleMonitorClient['serviceManagedLocations'],
    'isAllowed' | 'locations' | 'throttling'
  >;
}

export const getSyntheticsTaskProcessSettings = ({
  config,
  isCpsEnabled,
  serviceManagedLocations,
}: {
  config: SyntheticsServerSetup['config'];
  isCpsEnabled: boolean;
  serviceManagedLocations?: SyntheticsTaskProcessSettings['serviceManagedLocations'];
}): SyntheticsTaskProcessSettings => ({
  service: { manifestUrl: config.service?.manifestUrl, devUrl: config.service?.devUrl },
  isCpsEnabled,
  ...(serviceManagedLocations
    ? {
        serviceManagedLocations: {
          isAllowed: serviceManagedLocations.isAllowed,
          locations: serviceManagedLocations.locations,
          throttling: serviceManagedLocations.throttling,
        },
      }
    : {}),
});
