/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { getAnomalyDetectionAlertRuleType } from '../lib/alerts/register_anomaly_detection_alert_type';
import { taskType } from './anomaly_detection_alert.task';

describe('anomaly_detection_alert task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      getAnomalyDetectionAlertRuleType({ mlSharedServices: {} as never })
    );
  });

  it('reads the ml-job saved object type', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
  });
});
