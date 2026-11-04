/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
// eslint-disable-next-line no-restricted-imports -- this rule type exists only as the legacy one
import { legacyRulesNotificationRuleType } from '../lib/detection_engine/rule_actions_legacy';
import { taskType } from './notifications.task';

// The connector types are covered by the end to end test of the stack rule types.
jest.mock(
  '@kbn/stack-connectors-plugin/server/task_types/register_connector_types_for_rule_runs',
  () => ({ registerConnectorTypesForRuleRuns: jest.fn() })
);

describe('legacy notifications task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      legacyRulesNotificationRuleType({ logger: loggingSystemMock.createLogger() }) as never
    );
  });
});
