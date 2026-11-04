/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { LOG_THRESHOLD_ALERT_TYPE_ID } from '@kbn/rule-data-utils';
import { createUnsupportedRuleTaskType } from '@kbn/alerting-plugin/server/task_types/unsupported_rule_task_type';

/** The log threshold rule type. A task process cannot run it yet, so every run goes to Kibana. */
export const taskType = createUnsupportedRuleTaskType(
  LOG_THRESHOLD_ALERT_TYPE_ID,
  'its executor resolves log views through plugins that only exist in Kibana'
);
