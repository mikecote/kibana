/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import type { RuleReferenceInjector } from './common/inject_references';
import type { RulesClientContext } from './types';

export type RuleReadTypeDescriptor = RuleReferenceInjector &
  Pick<UntypedNormalizedRuleType, 'getViewInAppRelativeUrl'>;

export interface RulesReadRegistry {
  get: (id: string) => RuleReadTypeDescriptor;
  ensureRuleTypeEnabled: (id: string) => void;
}

export type RulesReadContext = Pick<
  RulesClientContext,
  'auditLogger' | 'authorization' | 'unsecuredSavedObjectsClient' | 'logger' | 'isSystemAction'
> & { ruleTypeRegistry: RulesReadRegistry };
