/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { durationAnomalyAlertFactory } from '../legacy_uptime/lib/alerts/duration_anomaly';
import { taskType } from './duration_anomaly.task';

describe('duration_anomaly task type module', () => {
  it('builds the rule type that the uptime plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      durationAnomalyAlertFactory(
        { basePath: {}, share: { url: { locators: { get: () => undefined } } } } as never,
        {} as never,
        { ml: {} } as never
      )
    );
  });

  it('reads the ml-job saved object type', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
  });
});
