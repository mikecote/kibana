/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ApmRuleType } from '@kbn/rule-data-utils';
import { registerTransactionErrorRateRuleType } from '../routes/alerts/rule_types/transaction_error_rate/register_transaction_error_rate_rule_type';
import { createApmRuleTaskType } from './apm_rule_task_type';

/** The `ApmRuleType.TransactionErrorRate` rule type, which a task process can run. */
export const taskType = createApmRuleTaskType(
  ApmRuleType.TransactionErrorRate,
  registerTransactionErrorRateRuleType
);
