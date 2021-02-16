/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import {
  SavedObjectsServiceSetup,
  SavedObjectsType,
  SavedObjectsComplexFieldMapping,
  SavedObjectsTypeMappingDefinition,
  SavedObjectsFieldMapping,
} from 'kibana/server';
import mappings from './mappings.json';
import { getMigrations } from './migrations';
import { EncryptedSavedObjectsPluginSetup } from '../../../encrypted_saved_objects/server';

export { partiallyUpdateAlert } from './partially_update_alert';

export const AlertAttributesExcludedFromAAD = [
  'scheduledTaskId',
  'muteAll',
  'mutedInstanceIds',
  'updatedBy',
  'updatedAt',
  'executionStatus',
];

const alertParamMappings: Record<string, SavedObjectsFieldMapping> = {};

// useful for Pick<RawAlert, AlertAttributesExcludedFromAADType> which is a
// type which is a subset of RawAlert with just attributes excluded from AAD

// useful for Pick<RawAlert, AlertAttributesExcludedFromAADType>
export type AlertAttributesExcludedFromAADType =
  | 'scheduledTaskId'
  | 'muteAll'
  | 'mutedInstanceIds'
  | 'updatedBy'
  | 'updatedAt'
  | 'executionStatus';

export function setupSavedObjects(
  savedObjects: SavedObjectsServiceSetup,
  encryptedSavedObjects: EncryptedSavedObjectsPluginSetup
) {
  savedObjects.registerType({
    name: 'alert',
    hidden: true,
    namespaceType: 'single',
    migrations: getMigrations(encryptedSavedObjects),
    mappings: mappings.alert,
    hooks: [
      savedObjects.createHooks({
        mappings(currentMappings: SavedObjectsType['mappings']) {
          return {
            ...currentMappings,
            properties: {
              ...currentMappings.properties,
              searchableParamsByType: {
                ...currentMappings.properties.searchableParamsByType,
                properties: {
                  ...(currentMappings.properties
                    .searchableParamsByType as SavedObjectsComplexFieldMapping).properties,
                  ...alertParamMappings,
                },
              },
            },
          } as SavedObjectsTypeMappingDefinition;
        },
      }),
    ],
  });

  savedObjects.registerType({
    name: 'api_key_pending_invalidation',
    hidden: true,
    namespaceType: 'agnostic',
    mappings: {
      properties: {
        apiKeyId: {
          type: 'keyword',
        },
        createdAt: {
          type: 'date',
        },
      },
    },
  });

  // Encrypted attributes
  encryptedSavedObjects.registerType({
    type: 'alert',
    attributesToEncrypt: new Set(['apiKey']),
    attributesToExcludeFromAAD: new Set(AlertAttributesExcludedFromAAD),
  });

  // Encrypted attributes
  encryptedSavedObjects.registerType({
    type: 'api_key_pending_invalidation',
    attributesToEncrypt: new Set(['apiKeyId']),
  });
}

// TODO Only throw error if field is mapped in different ways
export function setAlertTypeParamMapping(paramMappings: SavedObjectsComplexFieldMapping) {
  const alertParamMappedKeys = Object.keys(alertParamMappings);
  const alertTypeParamMappedKeys = Object.keys(paramMappings.properties);
  const mappedKeysIntersection = alertParamMappedKeys.filter((key: string) =>
    alertTypeParamMappedKeys.includes(key)
  );
  if (mappedKeysIntersection.length > 0) {
    throw new Error(
      i18n.translate('xpack.alerts.setAlertTypeParamMapping.paramMappingExists', {
        defaultMessage: 'Param fields {fields} has already has mapping defined.',
        values: {
          fields: mappedKeysIntersection.join(', '),
        },
      })
    );
  }

  Object.assign(alertParamMappings, paramMappings.properties);
  console.log(alertParamMappings);
}
