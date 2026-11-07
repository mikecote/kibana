/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { FleetPackageMetadataTaskProcessSettings } from '../../package_metadata_task_process_settings';
import {
  createFleetRunServices,
  startFleetRunAppContext,
  stopFleetRunAppContext,
  type FleetRunServices,
} from './fleet_run_services';

export interface FleetWorkflowRunServices {
  getServices: () => Promise<FleetRunServices>;
}

/** Creates task-owned native Fleet services with the dispatch configuration and run lifecycle. */
export const createFleetWorkflowRunServices = (
  host: TaskHost,
  packageMetadata: FleetPackageMetadataTaskProcessSettings
): FleetWorkflowRunServices => {
  let services: Promise<FleetRunServices> | undefined;
  const build = async (): Promise<FleetRunServices> => {
    const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
    if (!security || !host.licensing || !host.encryptedSavedObjects || !host.onRunEnd) {
      throw new Error(
        'Native Fleet workflow services require Security, licensing, encryption and run lifecycle services'
      );
    }
    const deps = {
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      encryptedSavedObjects: host.encryptedSavedObjects,
      loggerFactory: { get: (...parts: string[]) => host.logger.get('fleet', ...parts) },
    };
    host.onRunEnd(async () => stopFleetRunAppContext());
    await startFleetRunAppContext({
      ...deps,
      packageMetadata,
      license$: host.licensing.license$,
      audit: security.audit,
      securityLicense: security.license,
      kibanaVersion: host.server.version,
      kibanaInstanceId: host.server.uuid,
      isFipsEnabled: host.security.fips.isEnabled(),
    });
    return createFleetRunServices(deps);
  };
  return { getServices: () => (services ??= build()) };
};
