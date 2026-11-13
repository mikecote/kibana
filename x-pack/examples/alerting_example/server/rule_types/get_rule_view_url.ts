/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { GetViewInAppRelativeUrlFnOpts, RuleTypeParams } from '@kbn/alerting-plugin/server';
import { ALERTING_EXAMPLE_APP_ID } from '../../common/constants';

/** Builds the example rule's native details URL. */
export const getAstrosRuleViewUrl = ({
  rule,
}: GetViewInAppRelativeUrlFnOpts<RuleTypeParams>): string =>
  `/app/${ALERTING_EXAMPLE_APP_ID}/astros/${rule.id}`;
