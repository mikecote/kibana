/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SYNTHETICS_TLS_RULE } from '@kbn/rule-data-utils';
import { createUnsupportedRuleTaskType } from '@kbn/alerting-plugin/server/task_types/unsupported_rule_task_type';

/** The TLS rule type. A task process cannot run it yet, so every run goes to Kibana. */
export const taskType = createUnsupportedRuleTaskType(
  SYNTHETICS_TLS_RULE,
  'its executor reads Fleet, private locations and the synthetics service, which only exist in Kibana'
);
