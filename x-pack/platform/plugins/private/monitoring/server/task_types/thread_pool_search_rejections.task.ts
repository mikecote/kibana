/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RULE_THREAD_POOL_SEARCH_REJECTIONS } from '../../common/constants';
import { ThreadPoolSearchRejectionsRule } from '../rules/thread_pool_search_rejections_rule';
import { createMonitoringRuleTaskType } from './monitoring_rule_task_type';

/** The `RULE_THREAD_POOL_SEARCH_REJECTIONS` rule type, which a task process can run. */
export const taskType = createMonitoringRuleTaskType(
  RULE_THREAD_POOL_SEARCH_REJECTIONS,
  () => new ThreadPoolSearchRejectionsRule()
);
