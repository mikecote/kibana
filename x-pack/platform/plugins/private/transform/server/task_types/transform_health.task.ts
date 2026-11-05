/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { createStandaloneFieldFormats } from '@kbn/alerting-plugin/server/task_types/standalone/field_formats';
import { TRANSFORM_RULE_TYPE } from '../../common/constants';
import { getTransformHealthRuleType } from '../lib/alerting/transform_health_rule_type/register_transform_health_rule_type';

/** The `transform_health` rule type, which a task process can run. */
export const taskType = createRuleTaskType({
  ruleTypeId: TRANSFORM_RULE_TYPE.TRANSFORM_HEALTH,
  getRuleType: () =>
    getTransformHealthRuleType(() => createStandaloneFieldFormats() as never) as never,
});
