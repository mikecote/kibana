/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom, of, type Observable } from 'rxjs';

import type { LoggerFactory } from '@kbn/core/server';
import type { IClusterClient } from '@kbn/core-elasticsearch-server';
import type { SavedObjectsServiceStart } from '@kbn/core-saved-objects-server';
import { SPACES_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import type { ILicense } from '@kbn/licensing-types';
import type { EncryptedSavedObjectsClient } from '@kbn/encrypted-saved-objects-plugin/server';
import type { SecurityPluginSetup } from '@kbn/security-plugin/server';

import type { FleetPackageMetadataTaskProcessSettings } from '../../package_metadata_task_process_settings';
import { parseExperimentalConfigValue } from '../../../common/experimental_features';
import { MESSAGE_SIGNING_KEYS_SAVED_OBJECT_TYPE } from '../../constants';
import { AgentServiceImpl } from '../agents/agent_service';
import type { AgentService } from '../agents/agent_service';
import { agentPolicyService } from '../agent_policy';
import { appContextService, DEFAULT_INCLUDED_HIDDEN_TYPES } from '../app_context';
import { FleetActionsClient } from '../actions/client';
import type { FleetActionsClientInterface } from '../actions/types';
import { PackageServiceImpl } from '../epm/package_service';
import type { PackageService } from '../epm/package_service';
import { runWithCache } from '../epm/packages/cache';
import { licenseService } from '../license';
import { packagePolicyService } from '../package_policy';
import { MessageSigningService } from '../security/message_signing_service';
import type { MessageSigningServiceInterface } from '../security/message_signing_service';

/**
 * What Fleet's services need to run, with explicit dependencies, so that Kibana (its `plugin.ts`)
 * and a task process (built from `TaskHost`) build them the same way.
 */
export interface FleetRunServicesDeps {
  /** Core's cluster client (`host.elasticsearch` in a task process). */
  elasticsearch: Pick<IClusterClient, 'asInternalUser'>;
  savedObjects: Pick<SavedObjectsServiceStart, 'getUnsafeInternalClient'>;
  encryptedSavedObjects: {
    getClient: (options?: { includedHiddenTypes?: string[] }) => EncryptedSavedObjectsClient;
  };
  loggerFactory: LoggerFactory;
}

/**
 * The Fleet services the response actions of Elastic Defend and Osquery use. The policy services and
 * `runWithCache` are Fleet's module singletons, which read the app context (`appContextService`):
 * Kibana's plugin starts it with all it has, `startFleetRunAppContext` starts it with what these
 * services read.
 */
export interface FleetRunServices {
  agentService: AgentService;
  packageService: PackageService;
  agentPolicyService: typeof agentPolicyService;
  packagePolicyService: typeof packagePolicyService;
  messageSigningService: MessageSigningServiceInterface;
  createFleetActionsClient: (packageName: string) => FleetActionsClientInterface;
  runWithCache: typeof runWithCache;
}

/** Builds the services. It reads nothing from the app context until a service is used. */
export const createFleetRunServices = ({
  elasticsearch,
  savedObjects,
  encryptedSavedObjects,
  loggerFactory,
}: FleetRunServicesDeps): FleetRunServices => {
  const internalEsClient = elasticsearch.asInternalUser;
  const internalSoClient = savedObjects.getUnsafeInternalClient({
    excludedExtensions: [SPACES_EXTENSION_ID],
  });

  return {
    agentService: new AgentServiceImpl(internalEsClient, internalSoClient),
    packageService: new PackageServiceImpl(internalEsClient, internalSoClient, loggerFactory.get()),
    agentPolicyService,
    packagePolicyService,
    messageSigningService: new MessageSigningService(
      loggerFactory,
      encryptedSavedObjects.getClient({
        includedHiddenTypes: [MESSAGE_SIGNING_KEYS_SAVED_OBJECT_TYPE],
      })
    ),
    createFleetActionsClient: (packageName: string) =>
      new FleetActionsClient(internalEsClient, packageName),
    runWithCache,
  };
};

export interface FleetRunAppContextDeps extends FleetRunServicesDeps {
  /** Core's real saved objects service, including the native import and export clients. */
  savedObjects: SavedObjectsServiceStart;
  encryptedSavedObjects: {
    canEncrypt: boolean;
    getClient: (options?: { includedHiddenTypes?: string[] }) => EncryptedSavedObjectsClient;
  };
  /** Fleet's actual dispatch-time registry configuration and file material. */
  packageMetadata: FleetPackageMetadataTaskProcessSettings;
  license$: Observable<ILicense>;
  /** `host.security.audit`, which the services write their audit records to. */
  audit: SecurityPluginSetup['audit'];
  securityLicense: SecurityPluginSetup['license'];
  kibanaVersion: string;
  kibanaInstanceId: string;
  isFipsEnabled: boolean;
}

/**
 * Starts Fleet's app context with the members the response action services read, which is what the
 * plugin's own `start` does with the rest of what it has. Only a task process calls it: Kibana's
 * plugin has already started it. It installs nothing; Kibana is the only installer. It resolves once
 * the license is known.
 */
export const startFleetRunAppContext = async (deps: FleetRunAppContextDeps): Promise<void> => {
  const { packageMetadata } = deps;
  if (packageMetadata.isFipsEnabled !== deps.isFipsEnabled) {
    throw new Error('Fleet execution and worker Core must use the same FIPS mode');
  }
  const { config, kibanaBranch, isProductionMode } = packageMetadata;
  appContextService.startExecution({
    elasticsearch: deps.elasticsearch,
    savedObjects: deps.savedObjects,
    encryptedSavedObjectsStart: {
      getClient: deps.encryptedSavedObjects.getClient,
    },
    encryptedSavedObjectsSetup: {
      canEncrypt: deps.encryptedSavedObjects.canEncrypt,
    },
    securitySetup: { audit: deps.audit, license: deps.securityLicense },
    configInitialValue: config,
    config$: of(config),
    experimentalFeatures: parseExperimentalConfigValue(
      config.enableExperimental ?? [],
      config.experimentalFeatures ?? {}
    ),
    logger: deps.loggerFactory.get(),
    kibanaVersion: deps.kibanaVersion,
    kibanaBranch,
    kibanaInstanceId: deps.kibanaInstanceId,
    isProductionMode,
    isFipsEnabled: deps.isFipsEnabled,
    registry: { kind: 'snapshot', settings: packageMetadata },
    // The types the owners of the others (alerting rule templates, SLO templates) register are not in
    // the type registry of a process that does not run those plugins, and Fleet's installs, which
    // use them, are Kibana's.
    includedHiddenTypes: DEFAULT_INCLUDED_HIDDEN_TYPES.filter((type) =>
      deps.savedObjects.getTypeRegistry().getType(type)
    ),
  });
  licenseService.stop();
  licenseService.start(deps.license$);
  // The license is fetched when first read, and the services check it when they are used.
  await firstValueFrom(deps.license$);
};

/** Releases Fleet's task-owned configuration and license subscriptions after execution cleanup. */
export const stopFleetRunAppContext = (): void => {
  appContextService.stop();
  licenseService.stop();
};
