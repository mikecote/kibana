/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';

import type { FieldFormatsStart } from '@kbn/field-formats-plugin/server';
import type { CoreAuditService } from '@kbn/core-security-server';
import type { SavedObjectsClientContract } from '@kbn/core-saved-objects-api-server';
import type { ResolveMlCapabilities } from '@kbn/ml-common-types/capabilities';
import type { MlCloud } from './ml_cloud';
import type { MlAuthorizationService } from './lib/capabilities/check_capabilities';
import type { DataRecognizerModuleFiles } from './models/data_recognizer/module_files';
import type { CompatibleModule, MlFeatures } from '../common/constants/app';
import type { MlLicense } from '../common/license';
import type { ServerlessInfo } from './types';
import { createSharedServices } from './shared_services';
import type {
  MlClusterClient,
  MlDataViews,
  MlUiSettings,
  MlServicesProviders,
  SharedServices,
} from './shared_services/shared_services';

/**
 * What the ML services read. The getters return null until the service they read exists, which is
 * what the plugin needs, because it creates the services in `setup` and Core and the plugins start
 * after; a task process, where everything exists already, returns the service.
 */
export interface MlRunServicesDeps {
  mlLicense: MlLicense;
  moduleFiles?: DataRecognizerModuleFiles;
  getClusterClient: () => MlClusterClient | null;
  getInternalSavedObjectsClient: () => SavedObjectsClientContract | null;
  getUiSettings: () => MlUiSettings | null;
  getFieldsFormat: () => FieldFormatsStart | null;
  getDataViews: () => MlDataViews;
  getAuditService: () => CoreAuditService | null;
  isMlReady: () => Promise<void>;
  compatibleModuleType: CompatibleModule | null;
  enabledFeatures: MlFeatures;
  serverless: ServerlessInfo;
  /** Native Spaces services for the user making the request. */
  getSpaces?: () => Promise<SpacesPluginStart>;
  cloud: MlCloud;
  authorization?: MlAuthorizationService;
  resolveMlCapabilities: ResolveMlCapabilities;
}

/**
 * The ML services, the shared ones that other plugins use and the internal ones of the ML rule types.
 * Kibana builds them with the plugin's services; a task process with the ones of its host.
 */
export const createMlRunServices = (
  deps: MlRunServicesDeps
): { sharedServicesProviders: SharedServices; internalServicesProviders: MlServicesProviders } =>
  createSharedServices(
    deps.mlLicense,
    deps.getSpaces,
    deps.cloud,
    deps.authorization,
    deps.resolveMlCapabilities,
    deps.getClusterClient,
    deps.getInternalSavedObjectsClient,
    deps.getUiSettings,
    deps.getFieldsFormat,
    deps.getDataViews,
    deps.getAuditService,
    deps.isMlReady,
    deps.compatibleModuleType,
    deps.enabledFeatures,
    deps.serverless,
    deps.moduleFiles
  );
