/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { thresholdRuleType } from '../lib/rules/custom_threshold/register_custom_threshold_rule_type';
import { taskType } from './custom_threshold.task';

describe('custom threshold task type module', () => {
  const observability = { customThresholdRule: { groupByPageSize: 10000 } };

  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      thresholdRuleType(
        { getStartServices: jest.fn() } as never,
        { publicBaseUrl: 'https://kibana.test' } as never,
        observability as never,
        { debug: jest.fn() } as never,
        {}
      ) as never,
      { observability }
    );
  });
});
