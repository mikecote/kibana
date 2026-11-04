/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createUnsupportedRuleTaskType } from '@kbn/alerting-plugin/server/task_types/unsupported_rule_task_type';
import { CLIENT_ALERT_TYPES } from '../../common/constants/uptime_alerts';

/** The `durationAnomaly` rule type. A task process cannot run it yet, so every run goes to Kibana. */
export const taskType = createUnsupportedRuleTaskType(
  CLIENT_ALERT_TYPES.DURATION_ANOMALY,
  'its executor needs the machine learning shared services, which only exist in Kibana'
);
