/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

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

const alertTypeParamMappings: Record<string, SavedObjectsFieldMapping> = {};

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
          const paramMappings = Object.keys(alertTypeParamMappings).reduce(
            (acc: Record<string, unknown>, alertTypeId) => {
              acc[alertTypeId.replace(/\./g, '__')] = alertTypeParamMappings[alertTypeId];
              return acc;
            },
            {}
          );
          return {
            ...currentMappings,
            properties: {
              ...currentMappings.properties,
              params: {
                ...currentMappings.properties.params,
                properties: {
                  ...(currentMappings.properties.params as SavedObjectsComplexFieldMapping)
                    .properties,
                  ...paramMappings,
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

export function setAlertTypeParamMapping(
  alertTypeId: string,
  paramMappings: SavedObjectsFieldMapping
) {
  alertTypeParamMappings[alertTypeId] = paramMappings;
}
