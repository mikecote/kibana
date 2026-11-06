/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { sloBurnRateRuleType } from '../lib/rules/slo_burn_rate/register';
import { taskType } from './slo_burn_rate.task';

describe('SLO burn rate task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      sloBurnRateRuleType({ publicBaseUrl: 'https://kibana.test' } as never)
    );
  });

  it('registers the saved object type of the SLO definitions the executor reads', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('slo');
  });
});
