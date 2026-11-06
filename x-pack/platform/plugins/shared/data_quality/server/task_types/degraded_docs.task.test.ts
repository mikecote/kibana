/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { DegradedDocsRuleType } from '@kbn/dataset-quality-plugin/server/rule_types/degraded_docs/register';
import { taskType } from './degraded_docs.task';

describe('degraded docs task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(taskType, DegradedDocsRuleType());
  });
});
