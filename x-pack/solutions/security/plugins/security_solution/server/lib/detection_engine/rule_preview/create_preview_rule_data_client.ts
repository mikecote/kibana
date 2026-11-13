/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRuleDataClient, IRuleDataService } from '@kbn/rule-registry-plugin/server';
import type { SecurityRuleRunConfig } from '../../../config';
import { getSecurityRuleDataServiceOptions } from '../rule_types/create_security_rule_run_services';
import previewPolicy from '../routes/index/preview_policy.json';

/** Creates the preview writer with the same mappings, aliases and retention policy as Main. */
export const createPreviewRuleDataClient = (
  ruleDataService: Pick<IRuleDataService, 'initializeIndex'>,
  config: Pick<SecurityRuleRunConfig, 'signalsIndex'>
): IRuleDataClient =>
  ruleDataService.initializeIndex({
    ...getSecurityRuleDataServiceOptions(config),
    additionalPrefix: '.preview',
    ilmPolicy: previewPolicy.policy,
    secondaryAlias: undefined,
  });
