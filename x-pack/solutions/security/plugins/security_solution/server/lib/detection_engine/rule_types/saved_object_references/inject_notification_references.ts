/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, SavedObjectReference } from '@kbn/core/server';
import { legacyInjectRuleIdReferences } from './inject_notification_rule_id_references';

/** Restores the rule references used by legacy notification rules. */
export const legacyInjectReferences = <Params extends { ruleAlertId: string }>({
  logger,
  params,
  savedObjectReferences,
}: {
  logger: Logger;
  params: Params;
  savedObjectReferences: SavedObjectReference[];
}): Params => {
  const ruleAlertId = legacyInjectRuleIdReferences({
    logger,
    ruleAlertId: params.ruleAlertId,
    savedObjectReferences,
  });
  const ruleParamsWithSavedObjectReferences: Params = {
    ...params,
    ruleAlertId,
  };
  return ruleParamsWithSavedObjectReferences;
};
