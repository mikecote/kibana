/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { registerAnomalyRuleType } from '../routes/alerts/rule_types/anomaly/register_anomaly_rule_type';
import { taskType } from './anomaly.task';

describe('anomaly task type module', () => {
  const settings = {
    apm: {},
    apmSourcesAccess: { indices: {} },
  };

  it('builds the rule type that the apm plugin registers', () => {
    const registered = getRuleTypeFromRegistration((alerting) =>
      registerAnomalyRuleType({
        alerting,
        basePath: {},
        getApmIndices: async () => ({}),
        apmConfig: {},
        logger: loggingSystemMock.createLogger(),
        alertsLocator: undefined,
        ml: {},
      } as never)
    );
    expectModuleToMatchRegisteredRuleType(taskType, registered, settings);
  });

  it('reads the ml-job saved object type', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
  });
});
