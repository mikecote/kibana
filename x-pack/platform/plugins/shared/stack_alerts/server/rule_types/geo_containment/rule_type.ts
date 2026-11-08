/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { SavedObjectReference } from '@kbn/core/server';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import type { RuleParamsAndRefs } from '@kbn/alerting-plugin/server';
import { STACK_ALERTS_FEATURE_ID } from '@kbn/rule-data-utils';
import { trackingContainmentRuleParamsSchema } from '@kbn/response-ops-rule-params/geo_containment';
import type {
  GeoContainmentRuleType,
  GeoContainmentExtractedRuleParams,
  GeoContainmentRuleParams,
} from './types';
import { extractEntityAndBoundaryReferences, injectEntityAndBoundaryIds } from './references';
import { executor } from './executor';
import { ActionGroupId, RecoveryActionGroupId, GEO_CONTAINMENT_ID } from './constants';
import { STACK_ALERTS_AAD_CONFIG } from '../constants';

export { extractEntityAndBoundaryReferences, injectEntityAndBoundaryIds } from './references';

const actionVariables = {
  context: [
    // Alert-specific data
    {
      name: 'entityId',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextEntityIdLabel',
        {
          defaultMessage: 'The entity ID of the document that triggered the alert',
        }
      ),
    },
    {
      name: 'entityDateTime',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextFromEntityDateTimeLabel',
        {
          defaultMessage: `The date the entity was recorded in the boundary`,
        }
      ),
    },
    {
      name: 'entityDocumentId',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextFromEntityDocumentIdLabel',
        {
          defaultMessage: 'The ID of the contained entity document',
        }
      ),
    },
    {
      name: 'detectionDateTime',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextDetectionDateTimeLabel',
        {
          defaultMessage: 'The end of the check interval when the alert occurred',
        }
      ),
    },
    {
      name: 'entityLocation',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextFromEntityLocationLabel',
        {
          defaultMessage: 'The location of the entity',
        }
      ),
    },
    {
      name: 'containingBoundaryId',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextContainingBoundaryIdLabel',
        {
          defaultMessage:
            'The ID of the boundary containing the entity. Value not set for recovered alerts',
        }
      ),
    },
    {
      name: 'containingBoundaryName',
      description: i18n.translate(
        'xpack.stackAlerts.geoContainment.actionVariableContextContainingBoundaryNameLabel',
        {
          defaultMessage:
            'The name of the boundary containing the entity. Value not set for recovered alerts',
        }
      ),
    },
  ],
};

export function getRuleType(): GeoContainmentRuleType {
  const alertTypeName = i18n.translate('xpack.stackAlerts.geoContainment.alertTypeTitle', {
    defaultMessage: 'Tracking containment',
  });

  const actionGroupName = i18n.translate(
    'xpack.stackAlerts.geoContainment.actionGroupContainmentMetTitle',
    {
      defaultMessage: 'Tracking containment met',
    }
  );

  return {
    id: GEO_CONTAINMENT_ID,
    name: alertTypeName,
    actionGroups: [{ id: ActionGroupId, name: actionGroupName }],
    recoveryActionGroup: {
      id: RecoveryActionGroupId,
      name: i18n.translate('xpack.stackAlerts.geoContainment.notGeoContained', {
        defaultMessage: 'No longer contained',
      }),
    },
    doesSetRecoveryContext: true,
    defaultActionGroupId: ActionGroupId,
    executor,
    category: DEFAULT_APP_CATEGORIES.management.id,
    producer: STACK_ALERTS_FEATURE_ID,
    solution: 'stack',
    validate: {
      params: trackingContainmentRuleParamsSchema,
    },
    schemas: {
      params: {
        type: 'config-schema',
        schema: trackingContainmentRuleParamsSchema,
      },
    },
    actionVariables,
    minimumLicenseRequired: 'gold',
    isExportable: true,
    useSavedObjectReferences: {
      extractReferences: (
        params: GeoContainmentRuleParams
      ): RuleParamsAndRefs<GeoContainmentExtractedRuleParams> => {
        return extractEntityAndBoundaryReferences(params);
      },
      injectReferences: (
        params: GeoContainmentExtractedRuleParams,
        references: SavedObjectReference[]
      ) => {
        return injectEntityAndBoundaryIds(params, references);
      },
    },
    alerts: STACK_ALERTS_AAD_CONFIG,
  };
}
