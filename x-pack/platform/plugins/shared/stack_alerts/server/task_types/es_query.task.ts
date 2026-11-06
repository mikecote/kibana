/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ES_QUERY_ID } from '@kbn/rule-data-utils';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { createDiscoverAppLocatorDefinition } from '@kbn/discover-plugin/common/task_process_locator';
import { getRuleType } from '../rule_types/es_query/rule_type';

/** The `.es-query` rule type, which a task process can run: see the task types README of Task Manager. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: ES_QUERY_ID,
    getRuleType: ({ isServerless }) => getRuleType(isServerless) as never,
  },
  {
    // The link of the alert to Discover is built with the Discover locator.
    locators: [createDiscoverAppLocatorDefinition()],
  }
);
