/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SYNTHETICS_TLS_RULE } from '@kbn/rule-data-utils';
import { registerSyntheticsTLSCheckRule } from '../alert_rules/tls_rule/tls_rule';
import { createSyntheticsRuleTaskType } from './synthetics_rule_task_type';

/** The TLS rule type, which a task process can run. */
export const taskType = createSyntheticsRuleTaskType(
  SYNTHETICS_TLS_RULE,
  registerSyntheticsTLSCheckRule
);
