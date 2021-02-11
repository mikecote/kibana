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

const ALERT_TYPE_PARAMS_FIELD_PREFIX = 'alert.attributes.params';
const ALERT_TYPE_ID_FIELD_REGEX = new RegExp('alert.attributes.alertTypeId:[\\s(]*([^\\s]+)');

export const MAX_ALLOWED_ALERT_TYPE_MAPPED_PARAM_FIELDS = 15;

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

export function injectAlertTypeIdIntoSort(
  sortField: string,
  filter?: string,
  alertTypeId?: string
): string {
  if (!sortField.startsWith('params.')) {
    return sortField;
  }

  // if alertTypeId is not explicitly passed in, try to extract from the filter
  alertTypeId = alertTypeId ? alertTypeId : getAlertTypeIdFromFilter(filter);

  // throw exception if sortField contains alert params but not alert type is specified
  if (!alertTypeId) {
    throw new Error(`Must specify alertTypeId when sorting on alert type parameters`);
  }

  return sortField.replace(`params.`, `searchableParamsByType.${normalizeAlertTypeIdForMapping(alertTypeId)}.`);
}

export function injectAlertTypeIdIntoFilter(filter: string, alertTypeId?: string): string {
  if (!filter.includes(ALERT_TYPE_PARAMS_FIELD_PREFIX)) {
    return filter;
  }

  // if alertTypeId is not explicitly passed in, try to extract from the filter
  alertTypeId = alertTypeId ? alertTypeId : getAlertTypeIdFromFilter(filter);

  // throw exception if filter contains alert params but not alert type is specified
  if (!alertTypeId) {
    throw new Error(`Must specify alertTypeId when filtering on alert type parameters`);
  }

  // the saved object service validates against the mapping before executing
  // so parameter/alertTypeId mismatches will be caught there.

  // if we want to support an array of alertTypeIds in the future, this replace
  // function will need to be updated.
  return filter.replace(
    `alert.attributes.params`,
    `alert.attributes.searchableParamsByType.${normalizeAlertTypeIdForMapping(alertTypeId)}`
  );
}

export function getAlertTypeIdFromFilter(filter?: string): string | undefined {
  if (filter) {
    // this will only get the first specified alertTypeId in the filter
    // will have to update the regex in order to get multiple alertTypeIds
    const regexMatch = filter.match(ALERT_TYPE_ID_FIELD_REGEX);
    if (regexMatch && regexMatch[1]) {
      return regexMatch[1].replace('(', '').replace(')', '').split(' ')[0];
    }
  }
}
