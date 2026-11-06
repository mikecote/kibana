/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID } from '@kbn/rule-data-utils';
import { registerInventoryThresholdRuleType } from '../lib/alerting/inventory_metric_threshold/register_inventory_metric_threshold_rule_type';
import { createInfraRuleTaskType } from './infra_rule_task_type';

/** The inventory threshold rule type, which a task process can run. */
export const taskType = createInfraRuleTaskType(
  METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID,
  registerInventoryThresholdRuleType,
  {
    readsLogViews: true,
  }
);
