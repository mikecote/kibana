/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom, type Observable } from 'rxjs';
import type {
  AnalyticsServiceStart,
  IClusterClient,
  LoggerFactory,
  SavedObjectsServiceStart,
  SecurityServiceStart,
} from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';

import type { ExperimentalFeatures } from '../../../common';
import { LicenseService } from '../../../common/license';
import {
  EndpointAppContextService,
  type EndpointAppContextServiceInitializeContract,
  type EndpointAppContextServiceRunConfig,
} from '../endpoint_app_context_services';
import { FeatureUsageService, type FeatureUsageStart } from '../services/feature_usage/service';
import {
  getScheduleNotificationResponseActionsService,
  type ScheduleNotificationResponseActionsService,
} from '../../lib/detection_engine/rule_response_actions/schedule_notification_response_actions';
import type { SetupPlugins } from '../../plugin_contract';

export interface EndpointResponseActionsRunServicesDeps {
  /** `createFleetRunServices()` of Fleet */
  fleetRunServices: EndpointAppContextServiceInitializeContract['fleetStartServices'];
  elasticsearch: Pick<IClusterClient, 'asInternalUser'>;
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient'>;
  license$: Observable<ILicense>;
  config: EndpointAppContextServiceRunConfig;
  experimentalFeatures: ExperimentalFeatures;
  loggerFactory: LoggerFactory;
  /** `host.analytics` in a task process: events are reported with the run. */
  analytics: Pick<AnalyticsServiceStart, 'reportEvent'>;
  /** `host.security` in a task process. */
  security: Pick<SecurityServiceStart, 'authc' | 'audit'>;
  /** `host.licensing.featureUsage` in a task process, where the usage is reported with the run. */
  featureUsage?: FeatureUsageStart['featureUsage'];
  osqueryActionService?: SetupPlugins['osquery']['createActionService'];
}

export interface EndpointResponseActionsRunServices {
  endpointAppContextService: EndpointAppContextService;
  scheduleNotificationResponseActionsService: ScheduleNotificationResponseActionsService;
  /** Stops what the services keep running (the license subscription); call it with the process. */
  stop: () => void;
}

export { getEndpointResponseActionsRunSavedObjectTypes } from './saved_objects';

/**
 * The services the response actions of rules run on, from explicit dependencies: what a task process
 * builds from the task host. Kibana wires the same `EndpointAppContextService.initialize()` and
 * `getScheduleNotificationResponseActionsService()` from its own services; the registrations with
 * Fleet and the lists plugin (`startSideEffects()`) are Kibana's, so nothing is installed here.
 *
 * It resolves once the license is known, because response actions are checked against it.
 */
export const createEndpointResponseActionsRunServices = async ({
  fleetRunServices,
  elasticsearch,
  savedObjects,
  license$,
  config,
  experimentalFeatures,
  loggerFactory,
  analytics,
  security,
  featureUsage,
  osqueryActionService,
}: EndpointResponseActionsRunServicesDeps): Promise<EndpointResponseActionsRunServices> => {
  const licenseService = new LicenseService();
  licenseService.start(license$);
  // The license is fetched when first read, and the services read it when a run uses them.
  await firstValueFrom(license$);

  const featureUsageService = new FeatureUsageService();
  featureUsageService.start({ featureUsage });

  const endpointAppContextService = new EndpointAppContextService();
  endpointAppContextService.setup({ loggerFactory, telemetry: analytics });
  endpointAppContextService.initialize({
    fleetStartServices: fleetRunServices,
    security,
    config,
    licenseService,
    featureUsageService,
    experimentalFeatures,
    esClient: elasticsearch.asInternalUser,
    savedObjectsServiceStart: savedObjects,
  });

  return {
    endpointAppContextService,
    scheduleNotificationResponseActionsService: getScheduleNotificationResponseActionsService({
      endpointAppContextService,
      osqueryCreateActionService: osqueryActionService,
    }),
    stop: () => {
      endpointAppContextService.stop();
      licenseService.stop();
    },
  };
};
