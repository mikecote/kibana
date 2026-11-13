/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { RulesReadRegistry, RuleReadTypeDescriptor } from '../rules_client/rules_read_context';
import { getRegisteredRuleType } from '../lib/get_registered_rule_type';
import type { ILicenseState } from '../lib/license_state';
import type { RuleReadContribution, RuleReadSettings } from './rule_read_contribution';

/** Restores read callbacks only for the rule types present in Main's current registry. */
export const createRulesReadRegistry = ({
  settings,
  contributions,
  logger,
  licenseState,
}: {
  settings: RuleReadSettings;
  contributions: readonly RuleReadContribution[];
  logger: Logger;
  licenseState: Pick<ILicenseState, 'ensureLicenseForRuleType'>;
}): RulesReadRegistry => {
  const callbacks = new Map<string, RuleReadTypeDescriptor>();
  for (const contribution of contributions) {
    for (const [id, descriptor] of contribution.getDescriptors({ logger })) {
      if (callbacks.has(id)) throw new Error(`Duplicate native rule read descriptor: ${id}`);
      callbacks.set(id, descriptor);
    }
  }
  const metadata = new Map(settings.ruleTypes.map((ruleType) => [ruleType.id, ruleType]));
  const descriptors = new Map<string, RuleReadTypeDescriptor>();
  for (const ruleType of metadata.values()) {
    const descriptor = callbacks.get(ruleType.id);
    if (ruleType.hasReferenceInjector && !descriptor?.useSavedObjectReferences?.injectReferences)
      throw new Error(`Missing native reference injector for rule type ${ruleType.id}`);
    if (ruleType.hasViewInAppRelativeUrl && !descriptor?.getViewInAppRelativeUrl)
      throw new Error(`Missing native view URL callback for rule type ${ruleType.id}`);
    descriptors.set(ruleType.id, {
      ...(ruleType.hasReferenceInjector && {
        useSavedObjectReferences: descriptor?.useSavedObjectReferences,
      }),
      ...(ruleType.hasViewInAppRelativeUrl && {
        getViewInAppRelativeUrl: descriptor?.getViewInAppRelativeUrl,
      }),
    });
  }
  return {
    get: (id) => getRegisteredRuleType(descriptors, id),
    ensureRuleTypeEnabled: (id) =>
      licenseState.ensureLicenseForRuleType(getRegisteredRuleType(metadata, id)),
  };
};
