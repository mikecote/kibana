/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SYNTHETICS_STATUS_RULE } from '@kbn/rule-data-utils';
import { registerSyntheticsStatusCheckRule } from '../alert_rules/status_rule/monitor_status_rule';
import { createSyntheticsRuleTaskType } from './synthetics_rule_task_type';

/** The monitor status rule type, which a task process can run. */
export const taskType = createSyntheticsRuleTaskType(
  SYNTHETICS_STATUS_RULE,
  registerSyntheticsStatusCheckRule
);
