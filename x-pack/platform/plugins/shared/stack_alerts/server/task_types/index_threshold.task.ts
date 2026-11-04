/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { timeSeriesQuery } from '@kbn/triggers-actions-ui-plugin/server/data/lib/time_series_query';
import { registerConnectorTypesForRuleRuns } from '@kbn/stack-connectors-plugin/server/task_types/register_connector_types_for_rule_runs';
import { getRuleType, ID } from '../rule_types/index_threshold/rule_type';

/** The `.index-threshold` rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: ID,
    // Only `timeSeriesQuery` of the triggers actions UI data contract is used, and it needs nothing
    // but an Elasticsearch client.
    getRuleType: () => getRuleType(Promise.resolve({ timeSeriesQuery })) as never,
  },
  { registerConnectorTypes: registerConnectorTypesForRuleRuns }
);
