/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import { getObservabilityRuleViewUrl } from '@kbn/observability-plugin/server/lib/rules/get_rule_view_url';
import { SLO_BURN_RATE_RULE_TYPE_ID } from '@kbn/rule-data-utils';

export const contribution: RuleReadContribution = {
  getDescriptors: () => {
    const descriptors = new Map<string, RuleReadTypeDescriptor>(
      [SLO_BURN_RATE_RULE_TYPE_ID].map((id) => [
        id,
        { getViewInAppRelativeUrl: getObservabilityRuleViewUrl },
      ])
    );
    return descriptors;
  },
};
