/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SAVED_QUERY_RULE_TYPE_ID } from '@kbn/securitysolution-rules';
import { createUnsupportedRuleTaskType } from '@kbn/alerting-plugin/server/task_types/unsupported_rule_task_type';

/** The `SAVED_QUERY_RULE_TYPE_ID` detection rule type. A task process cannot run it yet, so every run goes to Kibana. */
export const taskType = createUnsupportedRuleTaskType(
  SAVED_QUERY_RULE_TYPE_ID,
  'its executor needs the rule registry, the lists and exceptions services, endpoint response actions and telemetry, which only exist in Kibana'
);
