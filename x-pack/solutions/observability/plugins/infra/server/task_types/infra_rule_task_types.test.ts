/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { config as infraConfigDescriptor } from '../config';
import type { InfraConfig } from '../types';
import { registerInventoryThresholdRuleType } from '../lib/alerting/inventory_metric_threshold/register_inventory_metric_threshold_rule_type';
import { registerLogThresholdRuleType } from '../lib/alerting/log_threshold/register_log_threshold_rule_type';
import { registerMetricThresholdRuleType } from '../lib/alerting/metric_threshold/register_metric_threshold_rule_type';
import { taskType as inventoryThreshold } from './inventory_metric_threshold.task';
import { taskType as logThreshold } from './log_threshold.task';
import { taskType as metricThreshold } from './metric_threshold.task';

describe('infra task type modules', () => {
  const infra = infraConfigDescriptor.schema.validate({}) as unknown as InfraConfig;
  const libs = {} as never;
  const locators = {} as never;

  it.each([
    ['metric threshold', metricThreshold, registerMetricThresholdRuleType],
    ['inventory threshold', inventoryThreshold, registerInventoryThresholdRuleType],
    ['log threshold', logThreshold, registerLogThresholdRuleType],
  ])('builds the %s rule type that the plugin registers', (_name, taskType, register) => {
    const registered = getRuleTypeFromRegistration((alerting) =>
      (register as Function)(alerting, libs, infra, locators)
    );
    expectModuleToMatchRegisteredRuleType(taskType, registered, { infra });
  });

  it('reads the log views the rule types resolve, and nothing else of the process', () => {
    expect(logThreshold.savedObjectTypes?.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'infrastructure-ui-source',
        'metrics-data-source',
        'infrastructure-monitoring-log-view',
      ])
    );
    expect(metricThreshold.savedObjectTypes?.map(({ name }) => name)).not.toContain(
      'infrastructure-monitoring-log-view'
    );
  });
});
