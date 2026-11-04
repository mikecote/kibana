/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID } from '@kbn/elastic-assistant-common/constants';
import { createUnsupportedRuleTaskType } from '@kbn/alerting-plugin/server/task_types/unsupported_rule_task_type';

/** The attack discovery rule type. A task process cannot run it yet, so every run goes to Kibana. */
export const taskType = createUnsupportedRuleTaskType(
  ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID,
  'its executor needs the inference plugin, the workflows engine and the actions connectors for the model, which only exist in Kibana'
);
