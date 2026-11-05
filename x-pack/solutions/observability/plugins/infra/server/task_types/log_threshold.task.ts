/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { LOG_THRESHOLD_ALERT_TYPE_ID } from '@kbn/rule-data-utils';
import { registerLogThresholdRuleType } from '../lib/alerting/log_threshold/register_log_threshold_rule_type';
import { createInfraRuleTaskType } from './infra_rule_task_type';

/** The log threshold rule type, which a task process can run. */
export const taskType = createInfraRuleTaskType(
  LOG_THRESHOLD_ALERT_TYPE_ID,
  registerLogThresholdRuleType,
  {
    readsLogViews: true,
  }
);
