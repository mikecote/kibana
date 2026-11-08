/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { GetViewInAppRelativeUrlFnOpts, RuleTypeParams } from '@kbn/alerting-plugin/server';
import { parseScheduleDates } from '@kbn/securitysolution-io-ts-utils';
import { getNotificationResultsLink } from './get_notification_results_link';

/** Builds the native Security rule results URL with its scheduled time range. */
export const getSecurityRuleViewUrl = ({
  rule,
  start,
  end,
}: GetViewInAppRelativeUrlFnOpts<RuleTypeParams>): string => {
  let startTime = null;
  let endTime = null;

  if (start && end) {
    startTime = new Date(start).toISOString();
    endTime = new Date(end).toISOString();
  } else if (rule.schedule?.interval) {
    startTime = `now-${rule.schedule?.interval}`;
    endTime = 'now';
  }
  if (!startTime || !endTime) {
    return '';
  }

  const fromInMs = parseScheduleDates(startTime)?.format('x');
  const toInMs = parseScheduleDates(endTime)?.format('x');

  return getNotificationResultsLink({
    from: fromInMs,
    to: toInMs,
    id: rule.id,
  });
};
