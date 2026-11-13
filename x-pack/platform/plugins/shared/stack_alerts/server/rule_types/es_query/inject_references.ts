/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectReference } from '@kbn/core/server';
import { injectReferences } from '@kbn/data-plugin/common';
import type { EsQueryRuleParams } from '@kbn/response-ops-rule-params/es_query';
import type { EsQueryRuleParamsExtractedParams } from './rule_type_params';
import { isSearchSourceRule } from './util';

/** Restores saved search references for an Elasticsearch query rule. */
export const injectEsQueryReferences = (
  params: EsQueryRuleParamsExtractedParams,
  references: SavedObjectReference[]
): EsQueryRuleParams => {
  if (isSearchSourceRule(params.searchType)) {
    return {
      ...params,
      searchConfiguration: injectReferences(params.searchConfiguration, references),
    };
  }
  return params;
};
