/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom, type Observable } from 'rxjs';
import type {
  AnalyticsServiceStart,
  CoreStart,
  IClusterClient,
  LoggerFactory,
} from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';
import type { FleetRunServices } from '@kbn/fleet-plugin/server/services/run_time';

import { createActionService } from '../handlers/action/create_action_service';
import type { OsqueryActionContext } from '../lib/osquery_app_context_services';
import { OsqueryAppContextService } from '../lib/osquery_app_context_services';

export interface OsqueryActionServiceDeps {
  fleetRunServices: Pick<
    FleetRunServices,
    | 'agentService'
    | 'packageService'
    | 'agentPolicyService'
    | 'packagePolicyService'
    | 'createFleetActionsClient'
  >;
  elasticsearch: Pick<IClusterClient, 'asInternalUser'>;
  savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
  license$: Observable<ILicense>;
  loggerFactory: LoggerFactory;
  /** `host.analytics` in a task process: the live query event is reported with the run. */
  analytics: Pick<AnalyticsServiceStart, 'reportEvent'>;
}

export { getOsqueryRunSavedObjectTypes } from './saved_objects';

/**
 * The service rules use to create osquery live queries (what the plugin returns from `setup` as
 * `createActionService`), built from explicit dependencies. A task process builds it from the task
 * host; it creates no index (the actions index is written to only if Kibana has created it). It
 * resolves once the license is known.
 */
export const createOsqueryActionService = async ({
  fleetRunServices,
  elasticsearch,
  savedObjects,
  license$,
  loggerFactory,
  analytics,
}: OsqueryActionServiceDeps) => {
  // The license is fetched when first read, and the service checks it when it creates an action.
  await firstValueFrom(license$);

  const service = new OsqueryAppContextService();
  service.start({
    agentService: fleetRunServices.agentService,
    packageService: fleetRunServices.packageService,
    agentPolicyService: fleetRunServices.agentPolicyService,
    packagePolicyService: fleetRunServices.packagePolicyService,
    createFleetActionsClient: fleetRunServices.createFleetActionsClient,
    logger: loggerFactory.get(),
    spacesService: undefined,
  });

  const context: OsqueryActionContext = {
    logFactory: loggerFactory,
    licensing: { license$ },
    getStartServices: async () => [
      { elasticsearch: { client: elasticsearch }, savedObjects } as Pick<
        CoreStart,
        'elasticsearch' | 'savedObjects'
      >,
    ],
    service,
    telemetryEventsSender: {
      reportEvent: (...args) => analytics.reportEvent(...args),
    },
  };

  return createActionService(context);
};
