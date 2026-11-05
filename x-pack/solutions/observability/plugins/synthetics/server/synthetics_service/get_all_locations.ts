/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { SavedObjectsClientContract } from '@kbn/core/server';
import { allLocationsToClientContract } from '../routes/settings/private_locations/location_contracts';
import { getPrivateLocationsAndAgentPolicies } from '../routes/settings/private_locations/get_private_locations';
import type { ServiceLocationsServer } from './get_service_locations';
import { getServiceLocations } from './get_service_locations';
import type { SyntheticsMonitorClient } from './synthetics_monitor/synthetics_monitor_client';

/** What looking up locations reads of the monitor client, which a task process builds without Fleet. */
export interface LocationsClient {
  serviceManagedLocations: Pick<
    SyntheticsMonitorClient['serviceManagedLocations'],
    'isAllowed' | 'locations' | 'throttling'
  >;
  privateLocationAPI: Pick<SyntheticsMonitorClient['privateLocationAPI'], 'getAgentPolicies'>;
}

export async function getAllLocations({
  syntheticsMonitorClient,
  savedObjectsClient,
  server,
  excludeAgentPolicies = false,
}: {
  server: ServiceLocationsServer;
  syntheticsMonitorClient: LocationsClient;
  savedObjectsClient: SavedObjectsClientContract;
  excludeAgentPolicies?: boolean;
}) {
  try {
    const [
      { locations: privateLocations, agentPolicies },
      { locations: publicLocations, throttling },
    ] = await Promise.all([
      getPrivateLocationsAndAgentPolicies(
        savedObjectsClient,
        syntheticsMonitorClient,
        excludeAgentPolicies
      ),
      getServicePublicLocations(server, syntheticsMonitorClient),
    ]);
    const pvtLocations = allLocationsToClientContract(
      { locations: privateLocations },
      agentPolicies
    );
    return {
      publicLocations,
      privateLocations: pvtLocations,
      throttling,
      allLocations: [...publicLocations, ...pvtLocations],
    };
  } catch (error) {
    server.logger.error(`Error getting Synthetics locations, Error: ${error.message}`, { error });
    return { publicLocations: [], privateLocations: [], allLocations: [] };
  }
}

const getServicePublicLocations = async (
  server: ServiceLocationsServer,
  syntheticsMonitorClient: LocationsClient
) => {
  if (!syntheticsMonitorClient.serviceManagedLocations.isAllowed) {
    return {
      locations: [],
    };
  }
  if (syntheticsMonitorClient.serviceManagedLocations.locations.length === 0) {
    return await getServiceLocations(server);
  }

  return {
    locations: syntheticsMonitorClient.serviceManagedLocations.locations,
    throttling: syntheticsMonitorClient.serviceManagedLocations.throttling,
  };
};
