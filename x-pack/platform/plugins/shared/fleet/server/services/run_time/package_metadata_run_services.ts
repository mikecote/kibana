/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';

import { SPACES_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import type { FieldsMetadataExtractors } from '@kbn/fields-metadata-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';

import { parseExperimentalConfigValue } from '../../../common/experimental_features';
import type { FleetPackageMetadataTaskProcessSettings } from '../../package_metadata_task_process_settings';

import { appContextService } from '../app_context';
import { PackageServiceImpl } from '../epm/package_service';
import { createFleetFieldsMetadataExtractors } from '../register_fields_metadata_extractors';

import { stopFleetRunAppContext } from './fleet_run_services';

/** Builds native package metadata clients using the dispatch snapshot and worker-owned Core services. */
export const createFleetPackageMetadataRunServices = (
  host: TaskHost,
  settings: FleetPackageMetadataTaskProcessSettings
): FieldsMetadataExtractors => {
  const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
  if (!security || !host.onRunEnd) {
    throw new Error(
      'Fleet package execution requires native task security and run lifecycle services'
    );
  }
  if (settings.isFipsEnabled !== host.security.fips.isEnabled()) {
    throw new Error('Fleet package execution and worker Core must use the same FIPS mode');
  }
  const { config, kibanaBranch, isProductionMode, isFipsEnabled } = settings;
  const logger = host.logger.get('fleet');
  const encryption = host.encryptedSavedObjects;
  appContextService.startExecution({
    elasticsearch: host.elasticsearch,
    savedObjects: host.savedObjects,
    ...(encryption
      ? {
          encryptedSavedObjectsStart: encryption,
          encryptedSavedObjectsSetup: encryption,
        }
      : {}),
    securitySetup: { audit: security.audit, license: security.license },
    configInitialValue: config,
    config$: of(config),
    experimentalFeatures: parseExperimentalConfigValue(
      config.enableExperimental ?? [],
      config.experimentalFeatures ?? {}
    ),
    logger,
    kibanaVersion: host.server.version,
    kibanaBranch,
    kibanaInstanceId: host.server.uuid,
    isProductionMode,
    isFipsEnabled,
    registry: { kind: 'snapshot', settings },
  });
  host.onRunEnd(() => {
    stopFleetRunAppContext();
    return Promise.resolve();
  });
  const internalClient = host.savedObjects.getUnsafeInternalClient({
    excludedExtensions: [SPACES_EXTENSION_ID],
  });
  const packages = new PackageServiceImpl(
    host.elasticsearch.asInternalUser,
    internalClient,
    logger
  );
  return createFleetFieldsMetadataExtractors({
    getPackageService: async () => packages.asInternalUser,
    getLogger: () => logger,
  });
};
