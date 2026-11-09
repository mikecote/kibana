/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { getAttackDiscoveryDataGeneratorRuleType } from '../lib/attack_discovery/data_generator_rule/definition';
import { taskType } from './attack_discovery_data_generator.task';

it('builds the development data-generator rule registered by Main', () => {
  expectModuleToMatchRegisteredRuleType(
    taskType,
    getAttackDiscoveryDataGeneratorRuleType({
      logger: loggingSystemMock.createLogger(),
      publicBaseUrl: undefined,
    })
  );
});
