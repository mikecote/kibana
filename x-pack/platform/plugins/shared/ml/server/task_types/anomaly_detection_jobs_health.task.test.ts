/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { getJobsMonitoringRuleType } from '../lib/alerts/register_jobs_monitoring_rule_type';
import { taskType } from './anomaly_detection_jobs_health.task';

describe('anomaly_detection_jobs_health task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      getJobsMonitoringRuleType({
        mlServicesProviders: {} as never,
        logger: loggingSystemMock.createLogger(),
      })
    );
  });

  it('reads the ml-job saved object type', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
  });
});
