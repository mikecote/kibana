/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ATTACK_DISCOVERY_DATA_GENERATOR_RULE_TYPE_ID } from '@kbn/elastic-assistant-common';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { getAttackDiscoveryDataGeneratorRuleType } from '../lib/attack_discovery/data_generator_rule/definition';

export const taskType = createRuleTaskType({
  ruleTypeId: ATTACK_DISCOVERY_DATA_GENERATOR_RULE_TYPE_ID,
  getRuleType: ({ logger, publicBaseUrl }) =>
    getAttackDiscoveryDataGeneratorRuleType({ logger, publicBaseUrl }),
});
