/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SLO_BURN_RATE_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { registerConnectorTypesForRuleRuns } from '@kbn/stack-connectors-plugin/server/task_types/register_connector_types_for_rule_runs';
import { sloBurnRateRuleType } from '../lib/rules/slo_burn_rate/register';

/** The SLO burn rate rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: SLO_BURN_RATE_RULE_TYPE_ID,
    // The executor only reads the public base URL of the base path.
    getRuleType: ({ publicBaseUrl }) => sloBurnRateRuleType({ publicBaseUrl } as never) as never,
  },
  { registerConnectorTypes: registerConnectorTypesForRuleRuns }
);
