/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleReadTypeDescriptor } from '@kbn/alerting-plugin/server/rules_client/rules_read_context';
import type { RuleReadContribution } from '@kbn/alerting-plugin/server/task_types/rule_read_contribution';
import { ES_QUERY_ID } from '@kbn/rule-data-utils';
import { GEO_CONTAINMENT_ID } from '../rule_types/geo_containment/constants';
import { injectEntityAndBoundaryIds } from '../rule_types/geo_containment/references';
import { injectEsQueryReferences } from '../rule_types/es_query/inject_references';

export const contribution: RuleReadContribution = {
  getDescriptors: () =>
    new Map<string, RuleReadTypeDescriptor>([
      [ES_QUERY_ID, { useSavedObjectReferences: { injectReferences: injectEsQueryReferences } }],
      [
        GEO_CONTAINMENT_ID,
        { useSavedObjectReferences: { injectReferences: injectEntityAndBoundaryIds } },
      ],
    ]),
};
