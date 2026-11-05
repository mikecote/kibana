/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { LEGACY_NOTIFICATIONS_ID } from '../../common/constants';
// eslint-disable-next-line no-restricted-imports -- this rule type exists only as the legacy one
import { legacyRulesNotificationRuleType } from '../lib/detection_engine/rule_actions_legacy';

/** The legacy notifications rule type, which a task process can run: it only needs a logger. */
export const taskType = createRuleTaskType({
  ruleTypeId: LEGACY_NOTIFICATIONS_ID,
  getRuleType: ({ logger }) => legacyRulesNotificationRuleType({ logger }) as never,
});
