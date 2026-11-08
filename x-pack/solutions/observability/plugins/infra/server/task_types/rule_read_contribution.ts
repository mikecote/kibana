/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import { getObservabilityRuleViewUrl } from '@kbn/observability-plugin/server/lib/rules/get_rule_view_url';
import {
  METRIC_THRESHOLD_ALERT_TYPE_ID,
  METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID,
} from '../../common/alerting/metrics';
import { LOG_DOCUMENT_COUNT_RULE_TYPE_ID } from '../../common/alerting/logs/log_threshold';
import { injectReferences } from '../lib/alerting/log_threshold/log_threshold_references_manager';

export const contribution: RuleReadContribution = {
  getDescriptors: () => {
    const descriptors = new Map<string, RuleReadTypeDescriptor>(
      [METRIC_THRESHOLD_ALERT_TYPE_ID, METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID].map((id) => [
        id,
        { getViewInAppRelativeUrl: getObservabilityRuleViewUrl },
      ])
    );
    descriptors.set(LOG_DOCUMENT_COUNT_RULE_TYPE_ID, {
      getViewInAppRelativeUrl: getObservabilityRuleViewUrl,
      useSavedObjectReferences: { injectReferences },
    });
    return descriptors;
  },
};
