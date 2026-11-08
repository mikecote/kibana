/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { createRulesReadRegistry } from './create_rules_read_registry';
import { getRuleReadSettings } from './rule_read_contribution';
import type { RuleReadSettings, RuleReadContribution } from './rule_read_contribution';

const logger = loggingSystemMock.createLogger();
const metadata: RuleReadSettings['ruleTypes'][number] = {
  id: 'test-rule',
  name: 'Test rule',
  isExportable: true,
  minimumLicenseRequired: 'gold',
  hasReferenceInjector: false,
  hasViewInAppRelativeUrl: false,
};
const licenseState = { ensureLicenseForRuleType: jest.fn() };
const create = (ruleType = metadata, contributions: RuleReadContribution[] = []) =>
  createRulesReadRegistry({
    settings: { ruleTypes: [ruleType] },
    contributions,
    logger,
    licenseState,
  });

it('restores only Main registrations and uses the actual license metadata', () => {
  const registry = create();
  expect(registry.get(metadata.id)).toEqual({});
  expect(() => registry.get('disabled-type')).toThrow('is not registered');
  registry.ensureRuleTypeEnabled(metadata.id);
  expect(licenseState.ensureLicenseForRuleType).toHaveBeenLastCalledWith(metadata);
  const error = new Error('License expired');
  licenseState.ensureLicenseForRuleType.mockImplementationOnce(() => {
    throw error;
  });
  expect(() => registry.ensureRuleTypeEnabled(metadata.id)).toThrow(error);
});

it.each([
  ['hasReferenceInjector', 'reference injector'],
  ['hasViewInAppRelativeUrl', 'view URL callback'],
] as const)('refuses a missing native callback required by %s', (field, message) => {
  expect(() => create({ ...metadata, [field]: true })).toThrow(message);
});

it('uses native callbacks and drops callbacks absent from Main', () => {
  const descriptor = {
    useSavedObjectReferences: { injectReferences: jest.fn() },
    getViewInAppRelativeUrl: jest.fn().mockReturnValue('/app/native'),
  };
  const contributions = [{ getDescriptors: () => new Map([[metadata.id, descriptor]]) }];
  const registry = create(
    { ...metadata, hasReferenceInjector: true, hasViewInAppRelativeUrl: true },
    contributions
  );
  expect(registry.get(metadata.id)).toEqual(descriptor);
  expect(create(metadata, contributions).get(metadata.id)).toEqual({});
  expect(() => create(metadata, [...contributions, ...contributions])).toThrow('Duplicate');
});

it('captures fresh registration metadata without serializing callbacks', () => {
  const registered = {
    id: metadata.id,
    name: metadata.name,
    isExportable: metadata.isExportable,
    minimumLicenseRequired: metadata.minimumLicenseRequired,
    getViewInAppRelativeUrl: () => '/app/native',
  };
  const registry = new Map([[registered.id, registered]]);
  const first = getRuleReadSettings({ list: () => registry });
  expect(first.ruleTypes).toEqual([{ ...metadata, hasViewInAppRelativeUrl: true }]);
  registry.clear();
  expect(getRuleReadSettings({ list: () => registry }).ruleTypes).toEqual([]);
  expect(first.ruleTypes).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
});
