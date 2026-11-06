/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { getTransformHealthRuleType } from '../lib/alerting/transform_health_rule_type/register_transform_health_rule_type';
import { taskType } from './transform_health.task';

describe('transform_health task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      getTransformHealthRuleType(() => ({} as never))
    );
  });
});
