/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsServiceSetup, SavedObjectsType } from '@kbn/core/server';
import type { EncryptedSavedObjectsPluginSetup } from '@kbn/encrypted-saved-objects-plugin/server';

import {
  getSyntheticsMonitorConfigSavedObjectType,
  SYNTHETICS_MONITOR_ENCRYPTED_TYPE,
} from './synthetics_monitor/synthetics_monitor_config';
import { syntheticsSettings } from './synthetics_settings';
import { syntheticsSettingsMultiSpace } from './synthetics_settings_multi_space';
import {
  SYNTHETICS_PARAMS_SECRET_ENCRYPTED_TYPE,
  syntheticsParamSavedObjectType,
} from './synthetics_param';
import {
  SYNTHETICS_SECRET_CONNECTION_ENCRYPTED_TYPE,
  syntheticsSecretConnectionSavedObjectType,
} from './synthetics_secret_connection';
import {
  LEGACY_PRIVATE_LOCATIONS_SAVED_OBJECT_TYPE,
  PRIVATE_LOCATION_SAVED_OBJECT_TYPE,
} from './private_locations';
import {
  getLegacySyntheticsMonitorSavedObjectType,
  LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE,
} from './synthetics_monitor/legacy_synthetics_monitor';
import { syntheticsServiceApiKey } from './service_api_key';
import { syntheticsMonitorSOTypes } from '../../common/types/saved_objects';

export const registerSyntheticsSavedObjects = (
  savedObjectsService: SavedObjectsServiceSetup,
  encryptedSavedObjects: EncryptedSavedObjectsPluginSetup
) => {
  savedObjectsService.registerType(LEGACY_PRIVATE_LOCATIONS_SAVED_OBJECT_TYPE);
  savedObjectsService.registerType(PRIVATE_LOCATION_SAVED_OBJECT_TYPE);

  savedObjectsService.registerType(syntheticsSettings);
  savedObjectsService.registerType(syntheticsSettingsMultiSpace);

  // legacy synthetics monitor saved object type which is single namespace
  savedObjectsService.registerType(
    getLegacySyntheticsMonitorSavedObjectType(encryptedSavedObjects)
  );
  encryptedSavedObjects.registerType(LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE);

  // synthetics monitor config saved object type which supports multiple namespace
  savedObjectsService.registerType(getSyntheticsMonitorConfigSavedObjectType());
  encryptedSavedObjects.registerType(SYNTHETICS_MONITOR_ENCRYPTED_TYPE);

  // service api key saved object type
  savedObjectsService.registerType(syntheticsServiceApiKey);
  encryptedSavedObjects.registerType({
    type: syntheticsServiceApiKey.name,
    attributesToEncrypt: new Set(['apiKey']),
    attributesToIncludeInAAD: new Set(['id', 'name']),
  });

  // global params saved object type
  savedObjectsService.registerType(syntheticsParamSavedObjectType);
  encryptedSavedObjects.registerType(SYNTHETICS_PARAMS_SECRET_ENCRYPTED_TYPE);

  // HashiCorp Vault connection saved object type
  savedObjectsService.registerType(syntheticsSecretConnectionSavedObjectType);
  encryptedSavedObjects.registerType(SYNTHETICS_SECRET_CONNECTION_ENCRYPTED_TYPE);
};

/**
 * The saved object types a task process reads to run the rules of this plugin: the monitors and the
 * private locations. Collected from the code that registers them in Kibana, so both agree. Migrations
 * are built but never run, because Kibana migrates every document before any task runs.
 */
export const getSyntheticsRuleSavedObjectTypes = (): SavedObjectsType[] => {
  const savedObjectTypes: SavedObjectsType[] = [];
  registerSyntheticsSavedObjects(
    { registerType: (type: SavedObjectsType) => savedObjectTypes.push(type) } as never,
    {
      registerType: () => undefined,
      createMigration: () => () => {
        throw new Error('A saved object migration is not available in a task process');
      },
    } as never
  );
  const names = new Set<string>([
    ...syntheticsMonitorSOTypes,
    PRIVATE_LOCATION_SAVED_OBJECT_TYPE.name,
    LEGACY_PRIVATE_LOCATIONS_SAVED_OBJECT_TYPE.name,
  ]);
  return savedObjectTypes.filter(({ name }) => names.has(name));
};
