/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { i18n } from '@kbn/i18n';
import { sum } from 'lodash';
import {
  SavedObjectsCoreFieldMapping,
  SavedObjectsComplexFieldMapping,
  SavedObjectsFieldMapping,
  SavedObjectsMappingProperties,
} from 'kibana/server';

export const MAX_ALLOWED_ALERT_TYPE_MAPPED_PARAM_FIELDS = 15;

// Are we allowing "type": "nested"? It doesn't affect the field mapping but it will affect
// the query in the alerts client.
export function validateAlertTypeParamMappings(
  alertTypeId: string,
  paramMappings: SavedObjectsComplexFieldMapping
): number {
  const numberOfMappedFields = countMappedFields(paramMappings);

  if (numberOfMappedFields > MAX_ALLOWED_ALERT_TYPE_MAPPED_PARAM_FIELDS) {
    throw new Error(
      i18n.translate('xpack.alerts.validateAlertTypeParamMappings.tooManyFieldsError', {
        defaultMessage:
          'Alert type "{id}" has {numberOfMappedFields} mapped fields, which exceeds the max value of {max}.',
        values: {
          id: alertTypeId,
          numberOfMappedFields,
          max: MAX_ALLOWED_ALERT_TYPE_MAPPED_PARAM_FIELDS,
        },
      })
    );
  }

  return numberOfMappedFields;
}

export function countMappedFields(
  mapping: SavedObjectsFieldMapping | SavedObjectsMappingProperties
): number {
  if ((mapping as SavedObjectsComplexFieldMapping).enabled === false) {
    return 0;
  } else if ((mapping as SavedObjectsComplexFieldMapping).properties) {
    return countMappedFields((mapping as SavedObjectsComplexFieldMapping).properties);
  } else if ((mapping as SavedObjectsCoreFieldMapping).type) {
    return (mapping as SavedObjectsCoreFieldMapping).fields !== undefined
      ? Object.keys((mapping as SavedObjectsCoreFieldMapping).fields!).length + 1
      : 1;
  } else {
    return sum(
      Object.keys(mapping as SavedObjectsMappingProperties).map((field: string) =>
        countMappedFields((mapping as SavedObjectsMappingProperties)[field])
      )
    );
  }
}

export function normalizeAlertTypeIdForMapping(alertTypeId: string): string {
  return alertTypeId.replace(/\./g, '__');
}
