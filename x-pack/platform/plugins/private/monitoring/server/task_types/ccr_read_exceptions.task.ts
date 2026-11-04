/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RULE_CCR_READ_EXCEPTIONS } from '../../common/constants';
import { CCRReadExceptionsRule } from '../rules/ccr_read_exceptions_rule';
import { createMonitoringRuleTaskType } from './monitoring_rule_task_type';

/** The `RULE_CCR_READ_EXCEPTIONS` rule type, which a task process can run. */
export const taskType = createMonitoringRuleTaskType(
  RULE_CCR_READ_EXCEPTIONS,
  () => new CCRReadExceptionsRule()
);
