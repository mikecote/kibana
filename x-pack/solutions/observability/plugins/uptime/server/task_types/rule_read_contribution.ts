/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import { getObservabilityRuleViewUrl } from '@kbn/observability-plugin/server/lib/rules/get_rule_view_url';
import { CLIENT_ALERT_TYPES } from '../../common/constants/uptime_alerts';

export const contribution: RuleReadContribution = {
  getDescriptors: () => {
    const descriptors = new Map<string, RuleReadTypeDescriptor>(
      [
        CLIENT_ALERT_TYPES.MONITOR_STATUS,
        CLIENT_ALERT_TYPES.TLS_LEGACY,
        CLIENT_ALERT_TYPES.DURATION_ANOMALY,
        CLIENT_ALERT_TYPES.TLS,
      ].map((id) => [id, { getViewInAppRelativeUrl: getObservabilityRuleViewUrl }])
    );
    return descriptors;
  },
};
