/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createSingleRuleTypeRegistry } from './single_rule_type_registry';

describe('createSingleRuleTypeRegistry', () => {
  const ruleType = { id: 'test.rule' } as never;
  const licenseState = { ensureLicenseForRuleType: jest.fn() };
  const registry = createSingleRuleTypeRegistry(() => ruleType, licenseState);

  it('has its rule type and no other', () => {
    expect(registry.has('test.rule')).toBe(true);
    expect(registry.has('other')).toBe(false);
    expect(registry.get('test.rule')).toBe(ruleType);
    expect(() => registry.get('other')).toThrow(/not served by this task process/);
  });

  it('checks the license of its rule type', () => {
    registry.ensureRuleTypeEnabled('test.rule');
    expect(licenseState.ensureLicenseForRuleType).toHaveBeenCalledWith(ruleType);
    expect(() => registry.ensureRuleTypeEnabled('other')).toThrow();
  });
});
