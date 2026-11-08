/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { GetViewInAppRelativeUrlFnOpts, RuleTypeParams } from '@kbn/alerting-plugin/server';
import { observabilityPaths } from '../../../common';

/** Builds the native rule details URL for Observability rule types. */
export const getObservabilityRuleViewUrl = ({
  rule,
}: GetViewInAppRelativeUrlFnOpts<RuleTypeParams>): string =>
  observabilityPaths.ruleDetails(rule.id);
