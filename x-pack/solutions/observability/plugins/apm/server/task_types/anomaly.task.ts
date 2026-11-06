/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ApmRuleType } from '@kbn/rule-data-utils';
import { registerAnomalyRuleType } from '../routes/alerts/rule_types/anomaly/register_anomaly_rule_type';
import { createApmRuleTaskType } from './apm_rule_task_type';

/** The `ApmRuleType.Anomaly` rule type, which a task process can run with the machine learning services of its host. */
export const taskType = createApmRuleTaskType(ApmRuleType.Anomaly, registerAnomalyRuleType, {
  usesMl: true,
});
