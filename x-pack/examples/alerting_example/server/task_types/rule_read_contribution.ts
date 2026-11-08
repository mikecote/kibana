/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import { getAstrosRuleViewUrl } from '../rule_types/get_rule_view_url';

export const contribution: RuleReadContribution = {
  getDescriptors: () =>
    new Map([['example.people-in-space', { getViewInAppRelativeUrl: getAstrosRuleViewUrl }]]),
};
