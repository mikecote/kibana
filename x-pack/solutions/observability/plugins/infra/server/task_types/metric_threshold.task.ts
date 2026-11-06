/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { METRIC_THRESHOLD_ALERT_TYPE_ID } from '@kbn/rule-data-utils';
import { registerMetricThresholdRuleType } from '../lib/alerting/metric_threshold/register_metric_threshold_rule_type';
import { createInfraRuleTaskType } from './infra_rule_task_type';

/** The metric threshold rule type, which a task process can run. */
export const taskType = createInfraRuleTaskType(
  METRIC_THRESHOLD_ALERT_TYPE_ID,
  registerMetricThresholdRuleType
);
