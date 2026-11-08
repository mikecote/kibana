/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import { OBSERVABILITY_THRESHOLD_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { getObservabilityRuleViewUrl } from '../lib/rules/get_rule_view_url';
import { injectCustomThresholdReferences } from '../lib/rules/custom_threshold/inject_references';

export const contribution: RuleReadContribution = {
  getDescriptors: () => {
    const descriptors = new Map<string, RuleReadTypeDescriptor>([
      [
        OBSERVABILITY_THRESHOLD_RULE_TYPE_ID,
        {
          getViewInAppRelativeUrl: getObservabilityRuleViewUrl,
          useSavedObjectReferences: { injectReferences: injectCustomThresholdReferences },
        },
      ],
    ]);
    return descriptors;
  },
};
