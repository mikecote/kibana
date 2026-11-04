/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { registerConnectorTypesForRuleRuns } from '@kbn/stack-connectors-plugin/server/task_types/register_connector_types_for_rule_runs';
import { GEO_CONTAINMENT_ID } from '../rule_types/geo_containment/constants';
import { getRuleType } from '../rule_types/geo_containment/rule_type';

/** The `.geo-containment` rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  { ruleTypeId: GEO_CONTAINMENT_ID, getRuleType: () => getRuleType() as never },
  { registerConnectorTypes: registerConnectorTypesForRuleRuns }
);
