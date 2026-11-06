/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ApmRuleType } from '@kbn/rule-data-utils';
import { registerErrorCountRuleType } from '../routes/alerts/rule_types/error_count/register_error_count_rule_type';
import { createApmRuleTaskType } from './apm_rule_task_type';

/** The `ApmRuleType.ErrorCount` rule type, which a task process can run. */
export const taskType = createApmRuleTaskType(ApmRuleType.ErrorCount, registerErrorCountRuleType);
