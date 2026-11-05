/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ECS_COMPONENT_TEMPLATE_NAME } from '@kbn/alerting-plugin/server';
import { mappingFromFieldMap } from '@kbn/alerting-plugin/common';
import type { IRuleDataService, IndexOptions } from '@kbn/rule-registry-plugin/server';
import { Dataset } from '@kbn/rule-registry-plugin/server';
import { SERVER_APP_ID } from '../../../../common/constants';
import type { SecurityRuleRunConfig } from '../../../config';
import { securityRuleTypeFieldMap } from './create_security_rule_type_wrapper';
import type { CreateSecurityRuleTypeWrapperProps } from './types';

/** The alerts index of the detection engine, as the rule data service installs and writes it. */
export const getSecurityRuleDataServiceOptions = (
  config: Pick<SecurityRuleRunConfig, 'signalsIndex'>
): IndexOptions => ({
  feature: SERVER_APP_ID,
  registrationContext: 'security',
  dataset: Dataset.alerts,
  componentTemplateRefs: [ECS_COMPONENT_TEMPLATE_NAME],
  componentTemplates: [
    {
      name: 'mappings',
      mappings: mappingFromFieldMap(securityRuleTypeFieldMap, false),
    },
  ],
  secondaryAlias: config.signalsIndex,
});

export interface SecurityRuleRunServicesDeps
  extends Omit<
    CreateSecurityRuleTypeWrapperProps,
    'ruleDataClient' | 'experimentalFeatures' | 'isPreview'
  > {
  /** An initialized rule data service: Kibana's own, or the one a task process builds over its host. */
  ruleDataService: Pick<IRuleDataService, 'initializeIndex'>;
}

/**
 * What `createSecurityRuleTypeWrapper` takes, from explicit dependencies: the detection engine's rule
 * types are built with it by the plugin, with the services of Kibana, and by the task type modules
 * of a task process, with the services of the process. Everything that does not depend on where the
 * rule runs, such as the alerts index and the experimental features, is derived here, once.
 */
export const createSecurityRuleRunServices = ({
  ruleDataService,
  ...deps
}: SecurityRuleRunServicesDeps): CreateSecurityRuleTypeWrapperProps => ({
  ...deps,
  experimentalFeatures: deps.config.experimentalFeatures,
  ruleDataClient: ruleDataService.initializeIndex(getSecurityRuleDataServiceOptions(deps.config)),
});
