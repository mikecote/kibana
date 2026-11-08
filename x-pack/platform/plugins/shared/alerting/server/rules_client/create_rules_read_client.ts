/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleTypeParams } from '../types';
import type { RulesClient } from './rules_client';
import type { RulesReadContext } from './rules_read_context';
import { getRule } from '../application/rule/methods/get';
import { findRules } from '../application/rule/methods/find';
import { bulkGetRules } from '../application/rule/methods/bulk_get';

export type RulesReadClient = Pick<RulesClient, 'get' | 'find' | 'bulkGetRules'>;

/** Creates scoped rule readers using the same authorization and transformations as RulesClient. */
export const createRulesReadClient = (context: RulesReadContext): RulesReadClient => ({
  get: <Params extends RuleTypeParams = never>(params: Parameters<RulesClient['get']>[0]) =>
    getRule<Params>(context, params),
  find: <Params extends RuleTypeParams = never>(params?: Parameters<RulesClient['find']>[0]) =>
    findRules<Params>(context, params),
  bulkGetRules: <Params extends RuleTypeParams = never>(
    params: Parameters<RulesClient['bulkGetRules']>[0]
  ) => bulkGetRules<Params>(context, params),
});
