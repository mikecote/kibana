/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RULE_LARGE_SHARD_SIZE } from '../../common/constants';
import { LargeShardSizeRule } from '../rules/large_shard_size_rule';
import { createMonitoringRuleTaskType } from './monitoring_rule_task_type';

/** The `RULE_LARGE_SHARD_SIZE` rule type, which a task process can run. */
export const taskType = createMonitoringRuleTaskType(
  RULE_LARGE_SHARD_SIZE,
  () => new LargeShardSizeRule()
);
