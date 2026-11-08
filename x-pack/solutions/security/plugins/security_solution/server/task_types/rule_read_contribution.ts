/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import { SECURITY_SOLUTION_RULE_TYPE_IDS } from '@kbn/securitysolution-rules';
import type { SavedObjectReference } from '@kbn/core/server';
import type { RuleParams } from '../lib/detection_engine/rule_schema';
import { LEGACY_NOTIFICATIONS_ID } from '../../common/constants';
import { injectReferences } from '../lib/detection_engine/rule_types/saved_object_references';
import { getSecurityRuleViewUrl } from '../lib/detection_engine/rule_types/get_rule_view_url';
import { legacyInjectReferences } from '../lib/detection_engine/rule_types/saved_object_references/inject_notification_references';

export const contribution: RuleReadContribution = {
  getDescriptors: ({ logger }) => {
    const descriptors = new Map<string, RuleReadTypeDescriptor>(
      SECURITY_SOLUTION_RULE_TYPE_IDS.map((id) => [
        id,
        {
          getViewInAppRelativeUrl: getSecurityRuleViewUrl,
          useSavedObjectReferences: {
            injectReferences: (params: RuleParams, savedObjectReferences: SavedObjectReference[]) =>
              injectReferences({ logger, params, savedObjectReferences }),
          },
        },
      ])
    );
    descriptors.set(LEGACY_NOTIFICATIONS_ID, {
      useSavedObjectReferences: {
        injectReferences: (
          params: { ruleAlertId: string },
          savedObjectReferences: SavedObjectReference[]
        ) => legacyInjectReferences({ logger, params, savedObjectReferences }),
      },
    });
    return descriptors;
  },
};
