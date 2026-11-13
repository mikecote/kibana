/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, Logger } from '@kbn/core/server';
import { MITRE_ATTACK_ENTITY_SO_TYPE } from '@kbn/security-mitre-attack-common';
import type { MitreAttackServerStart } from './types';
import { MitreAttackDataService } from './services/mitre_attack_data_service';
import { createMitreAttackDataClient } from './services/mitre_attack_data_client/mitre_attack_data_client';

export { mitreAttackEntityType } from './saved_objects';

/** Creates the managed MITRE client with the shared population and retry lifecycle. */
export const createMitreAttackRunServices = ({
  savedObjects,
  logger,
  trackBackgroundTask,
}: {
  savedObjects: Pick<CoreStart['savedObjects'], 'createInternalRepository'>;
  logger: Logger;
  trackBackgroundTask?: (task: Promise<void>) => void;
}): MitreAttackServerStart => {
  const savedObjectsRepository = savedObjects.createInternalRepository([
    MITRE_ATTACK_ENTITY_SO_TYPE,
  ]);
  const dataService = new MitreAttackDataService(logger);
  dataService.initialize(savedObjectsRepository);
  const population = dataService
    .populate()
    .then(() => {})
    .catch((err: Error) => {
      logger.error(`Unexpected error during MITRE data population: ${err.message}`);
    });
  trackBackgroundTask?.(population);
  const mitreDataClient = createMitreAttackDataClient({
    savedObjectsRepository,
    logger,
    dataService,
  });
  return { getMitreDataClient: () => mitreDataClient };
};
