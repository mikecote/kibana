/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema } from '../config';
import type { UntypedRuleType } from '../types';
import {
  applyRuleTypeDefaults,
  normalizeRuleType,
  RULE_TYPES_WITH_CUSTOM_COST,
} from './normalize_rule_type';

const logger = loggingSystemMock.createLogger();
const ruleType = () =>
  ({
    id: 'test.rule',
    name: 'Test rule',
    actionGroups: [{ id: 'default', name: 'Default' }],
    defaultActionGroupId: 'default',
    minimumLicenseRequired: 'basic',
    isExportable: true,
    executor: jest.fn(),
    category: 'test',
    producer: 'alerts',
    solution: 'stack',
    validate: { params: schema.any() },
  } as unknown as UntypedRuleType);

describe('normalizeRuleType', () => {
  it('sets what the framework sets on every rule type', () => {
    const normalized = normalizeRuleType(ruleType(), { config: configSchema.validate({}), logger });
    expect(normalized.ruleTaskTimeout).toBe('5m');
    expect(normalized.doesSetRecoveryContext).toBe(false);
    expect(normalized.autoRecoverAlerts).toBe(true);
    expect(normalized.cancelAlertsOnRuleTimeout).toBe(true);
    expect(normalized.actionVariables).toEqual({ context: [], state: [], params: [] });
    expect(normalized.recoveryActionGroup?.id).toBe('recovered');
    expect(normalized.actionGroups.map((group) => group.id)).toEqual(['default', 'recovered']);
  });

  it('applies the timeout configured for the rule type', () => {
    const config = configSchema.validate({
      rules: { run: { ruleTypeOverrides: [{ id: 'test.rule', timeout: '1m' }] } },
    });
    expect(normalizeRuleType(ruleType(), { config, logger }).ruleTaskTimeout).toBe('1m');
  });

  it('rejects an action group that the framework reserves', () => {
    const reserved = ruleType();
    reserved.actionGroups = [{ id: 'recovered', name: 'Recovered' }] as never;
    expect(() =>
      normalizeRuleType(reserved, { config: configSchema.validate({}), logger })
    ).toThrow(/reserved by the framework/);
  });
});

describe('applyRuleTypeDefaults', () => {
  it('ignores cancelAlertsOnRuleTimeout=false for a rule type that auto recovers alerts', () => {
    const target = ruleType();
    applyRuleTypeDefaults(target, {
      config: configSchema.validate({ cancelAlertsOnRuleTimeout: false }),
      logger,
    });
    expect(target.cancelAlertsOnRuleTimeout).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('incompatible'));
  });
});

describe('RULE_TYPES_WITH_CUSTOM_COST', () => {
  it('has a cost for the indicator match rule', () => {
    expect(RULE_TYPES_WITH_CUSTOM_COST['siem.indicatorRule']).toBeDefined();
  });
});
