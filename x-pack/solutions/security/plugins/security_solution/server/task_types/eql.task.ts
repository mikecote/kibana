/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EQL_RULE_TYPE_ID } from '@kbn/securitysolution-rules';
import { createEqlAlertType } from '../lib/detection_engine/rule_types';
import { createSecurityRuleTaskType } from './security_rule_task_type';

/** The `EQL_RULE_TYPE_ID` detection rule type, which a task process can run. */
export const taskType = createSecurityRuleTaskType(EQL_RULE_TYPE_ID, (wrap) =>
  wrap(createEqlAlertType())
);
