/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import type { ILicenseState } from '../../lib/license_state';
import type { UntypedNormalizedRuleType } from '../../rule_type_registry';
import type { RuleRunRuntime } from '../../task_runner/types';

/**
 * The only rule type a task process serves, as the registry a rule run reads: it has this rule type,
 * knows no other, and checks the license of this one when the rule is loaded.
 */
export const createSingleRuleTypeRegistry = (
  getRuleType: () => UntypedNormalizedRuleType,
  licenseState: Pick<ILicenseState, 'ensureLicenseForRuleType'>
): RuleRunRuntime['ruleTypeRegistry'] => {
  const get = (id: string) => {
    const ruleType = getRuleType();
    if (id !== ruleType.id) {
      throw Boom.badRequest(`Rule type "${id}" is not served by this task process.`);
    }
    return ruleType as never;
  };
  return {
    has: (id: string) => id === getRuleType().id,
    get,
    ensureRuleTypeEnabled: (id: string) => licenseState.ensureLicenseForRuleType(get(id)),
  };
};
