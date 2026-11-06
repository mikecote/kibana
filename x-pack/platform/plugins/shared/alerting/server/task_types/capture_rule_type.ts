/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { UntypedRuleType } from '../types';

/**
 * The rule type a plugin registers with `alerting.registerType(...)`, for plugins whose rule types
 * have no factory of their own: runs their registration against a stand-in for the alerting setup
 * contract that keeps what is registered.
 */
export const getRuleTypeFromRegistration = (
  register: (alerting: { registerType: (ruleType: never) => void }) => void
): UntypedRuleType => {
  let captured: UntypedRuleType | undefined;
  register({
    registerType: (ruleType) => {
      captured = ruleType as UntypedRuleType;
    },
  });
  if (!captured) throw new Error('The registration did not register a rule type');
  return captured;
};
