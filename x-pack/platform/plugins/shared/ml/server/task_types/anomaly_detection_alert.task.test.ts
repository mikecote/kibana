/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { getAnomalyDetectionAlertRuleType } from '../lib/alerts/register_anomaly_detection_alert_type';
import { taskType } from './anomaly_detection_alert.task';
import {
  createMlTaskProcessServices,
  ML_TASK_PROCESS_SETTINGS_ID,
} from './ml_task_process_services';
import { createMlRuleServicesDeps } from './ml_task_process_services.test_helpers';

describe('anomaly_detection_alert task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    const deps = createMlRuleServicesDeps();
    expectModuleToMatchRegisteredRuleType(
      taskType,
      getAnomalyDetectionAlertRuleType({
        mlSharedServices: createMlTaskProcessServices(deps).sharedServicesProviders,
      }),
      deps.settings
    );
  });

  it('reads the ml-job saved object type', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
    expect(taskType.settings).toContain(ML_TASK_PROCESS_SETTINGS_ID);
  });
});
