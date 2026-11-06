/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { LoggerFactory } from '@kbn/core/server';
import { SavedObjectsClient } from '@kbn/core/server';
import type { RuleTypeModuleDeps } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { FleetConfigType } from '@kbn/fleet-plugin/common/types';
import type { SecurityRuleRunConfig } from '../config';
import {
  getIsEndpointExceptionsPerPolicyEnabled,
  REFERENCE_DATA_SAVED_OBJECT_TYPE,
} from '../endpoint/lib/reference_data';
import type { SecurityRuleRunServicesDeps } from '../lib/detection_engine/rule_types/create_security_rule_run_services';

/** The id of Fleet's settings in a task process, `host.settings[id]`. */
export const FLEET_TASK_PROCESS_SETTINGS_ID = 'fleet';

const KIBANA_ONLY =
  'is only available in Kibana, not in a task process: a rule run only reads the per-policy endpoint exceptions opt-in and schedules response actions';

type ResponseActionsServices = Pick<
  SecurityRuleRunServicesDeps,
  | 'endpointAppContextService'
  | 'scheduleNotificationResponseActionsService'
  | 'getOsqueryResponseActionsAuthzChecker'
>;

/**
 * The services of the endpoint and osquery response actions that a detection rule uses in a task
 * process, built from the host: Fleet's services over its app context, osquery's action service and
 * the endpoint ones on top of them.
 *
 * Nothing is built until a run uses them: a rule without response actions, which is almost every
 * rule, never starts Fleet. The only thing every run reads is the opt-in of the per-policy endpoint
 * exceptions, a reference data saved object, which does not need them. Authorizing the response
 * actions of a rule is on its write paths, which Kibana serves, so the rest of the endpoint service
 * fails clearly when a run touches it.
 */
export const getResponseActionsServices = (
  deps: Pick<RuleTypeModuleDeps, 'host' | 'settings' | 'logger' | 'kibanaVersion'>
): ResponseActionsServices => {
  const { host, settings } = deps;
  const config = settings.securitySolution as SecurityRuleRunConfig;

  let built: ReturnType<typeof build> | undefined;
  const build = async () => {
    const fleetConfig = settings[FLEET_TASK_PROCESS_SETTINGS_ID] as FleetConfigType | undefined;
    if (!fleetConfig) {
      throw new Error(
        `The task process was not given the settings of ${FLEET_TASK_PROCESS_SETTINGS_ID}`
      );
    }
    if (!host.licensing || !host.encryptedSavedObjects) {
      throw new Error('The module must declare the licensing and encrypted saved objects');
    }
    const [
      { createFleetRunServices, startFleetRunAppContext },
      { createOsqueryActionService },
      { createEndpointResponseActionsRunServices },
    ] = await Promise.all([
      import('@kbn/fleet-plugin/server/services/run_time'),
      import('@kbn/osquery-plugin/server/run_time/create_osquery_action_service'),
      import('../endpoint/run_time/create_endpoint_response_actions_run_services'),
    ]);
    const { license$, featureUsage } = host.licensing;
    const loggerFactory = {
      get: (...parts: string[]) => host.logger.get(...parts),
    } as LoggerFactory;
    const fleetDeps = {
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      encryptedSavedObjects: host.encryptedSavedObjects,
      loggerFactory,
    };
    await startFleetRunAppContext({
      ...fleetDeps,
      config: fleetConfig,
      license$,
      audit: host.security.audit as never,
      kibanaVersion: deps.kibanaVersion,
      // Only used to pick the package registry and the install of Fleet, which a process never does.
      kibanaBranch: 'main',
      kibanaInstanceId: host.server.uuid,
      isProductionMode: true,
    });
    const fleetRunServices = createFleetRunServices(fleetDeps);
    const osqueryActionService = await createOsqueryActionService({
      fleetRunServices,
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      license$,
      loggerFactory,
      analytics: host.analytics,
    });
    return createEndpointResponseActionsRunServices({
      fleetRunServices,
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      license$,
      config,
      experimentalFeatures: config.experimentalFeatures,
      loggerFactory,
      analytics: host.analytics,
      security: host.security,
      featureUsage,
      osqueryActionService,
    });
  };
  const getServices = () => (built ??= build());

  return {
    // Called by every run, with no response actions most of the time.
    scheduleNotificationResponseActionsService: async (params) => {
      if (!params.signalsCount || !params.responseActions?.length) return;
      return (await getServices()).scheduleNotificationResponseActionsService(params);
    },
    endpointAppContextService: new Proxy(
      {} as ResponseActionsServices['endpointAppContextService'],
      {
        get: (_target, property) => {
          if (property === 'isEndpointExceptionsPerPolicyEnabled') {
            return async () =>
              config.experimentalFeatures.endpointExceptionsMovedUnderManagement
                ? getIsEndpointExceptionsPerPolicyEnabled(
                    new SavedObjectsClient(
                      host.savedObjects.createInternalRepository([REFERENCE_DATA_SAVED_OBJECT_TYPE])
                    ),
                    config.experimentalFeatures,
                    deps.logger
                  )
                : false;
          }
          // Not a method of the service: what introspects an object (a promise, a formatter) asks for it.
          if (typeof property === 'symbol' || property === 'then') return undefined;
          return () => {
            throw new Error(`EndpointAppContextService.${property} ${KIBANA_ONLY}`);
          };
        },
      }
    ),
    // Only the write paths of rules authorize response actions, which Kibana serves.
    getOsqueryResponseActionsAuthzChecker: undefined,
  };
};
