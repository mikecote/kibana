/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RULE_LICENSE_EXPIRATION } from '../../common/constants';
import { LicenseExpirationRule } from '../rules/license_expiration_rule';
import { createMonitoringRuleTaskType } from './monitoring_rule_task_type';

/** The `RULE_LICENSE_EXPIRATION` rule type, which a task process can run. */
export const taskType = createMonitoringRuleTaskType(
  RULE_LICENSE_EXPIRATION,
  () => new LicenseExpirationRule()
);
