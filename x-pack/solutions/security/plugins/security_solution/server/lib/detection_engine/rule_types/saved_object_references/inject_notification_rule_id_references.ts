/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, SavedObjectReference } from '@kbn/core/server';

/** Restores a legacy notification rule ID and reports a missing saved object reference. */
export const legacyInjectRuleIdReferences = ({
  logger,
  ruleAlertId,
  savedObjectReferences,
}: {
  logger: Logger;
  ruleAlertId: string;
  savedObjectReferences: SavedObjectReference[];
}): string => {
  const referenceFound = savedObjectReferences.find((reference) => {
    return reference.name === 'alert_0';
  });
  if (referenceFound) {
    return referenceFound.id;
  } else {
    logger.error(
      [
        'The saved object reference was not found for the "ruleAlertId" when we were expecting to find it. ',
        'Kibana migrations might not have run correctly or someone might have removed the saved object references manually. ',
        'Returning the last known good "ruleAlertId" which might not work. "ruleAlertId" with its id being returned is: ',
        ruleAlertId,
      ].join('')
    );
    return ruleAlertId;
  }
};
