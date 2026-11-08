/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import type { RuleReadTypeDescriptor } from '../rules_client/rules_read_context';

export const RULE_READ_CONTRIBUTIONS_KEY = 'alerting-rule-read';
export const RULE_READ_SETTINGS_ID = 'alertingRuleRead';

export interface RuleReadContribution {
  getDescriptors: (context: { logger: Logger }) => ReadonlyMap<string, RuleReadTypeDescriptor>;
}

export type RuleReadMetadata = Pick<
  UntypedNormalizedRuleType,
  'id' | 'name' | 'minimumLicenseRequired' | 'isExportable'
> & {
  hasReferenceInjector: boolean;
  hasViewInAppRelativeUrl: boolean;
};

export interface RuleReadSettings {
  ruleTypes: RuleReadMetadata[];
}

/** Captures the actual enabled registry without serializing executable callbacks. */
export const getRuleReadSettings = (registry: {
  list: () => ReadonlyMap<
    string,
    Pick<
      UntypedNormalizedRuleType,
      | 'id'
      | 'name'
      | 'minimumLicenseRequired'
      | 'isExportable'
      | 'useSavedObjectReferences'
      | 'getViewInAppRelativeUrl'
    >
  >;
}): RuleReadSettings => ({
  ruleTypes: [...registry.list().values()].map((ruleType) => ({
    id: ruleType.id,
    name: ruleType.name,
    isExportable: ruleType.isExportable,
    minimumLicenseRequired: ruleType.minimumLicenseRequired,
    hasReferenceInjector: Boolean(ruleType.useSavedObjectReferences?.injectReferences),
    hasViewInAppRelativeUrl: Boolean(ruleType.getViewInAppRelativeUrl),
  })),
});
