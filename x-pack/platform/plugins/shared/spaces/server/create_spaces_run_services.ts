/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';

import { NpreClient } from '@kbn/cps/server/npre';
import { KibanaFeature } from '@kbn/features-plugin/common';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';

import type { SpacesPluginStartApi } from './plugin';
import type { SpacesClientServiceSetup } from './spaces_client';
import { SpacesClientService } from './spaces_client';
import { SpacesService } from './spaces_service';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from './task_process_settings';
import type { SpacesTaskProcessSettings } from './task_process_settings';

/** Builds the authorized spaces service from the current run's settings and Core services. */
export const createSpacesRunServices = (
  host: TaskHost,
  setupSecurity: (spacesClient: SpacesClientServiceSetup) => void
): SpacesPluginStartApi => {
  const settings = host.settings?.[SPACES_TASK_PROCESS_SETTINGS_ID] as
    | SpacesTaskProcessSettings
    | undefined;
  if (!settings) {
    throw new Error('The spaces runtime requires its settings and security services');
  }
  const logger = host.logger.get('spaces');
  const clientService = new SpacesClientService(
    (message) => logger.debug(message),
    settings.buildFlavor
  );
  const spacesClient = clientService.setup({ config$: of(settings.config) });
  setupSecurity(spacesClient);
  const features = settings.features.map((feature) => new KibanaFeature(feature));
  const clients = clientService.start(
    { savedObjects: host.savedObjects },
    { getKibanaFeatures: () => features },
    settings.cpsEnabled
      ? {
          createNpreClient: (request) =>
            new NpreClient(logger, host.elasticsearch.asScoped(request)),
        }
      : undefined
  );
  return {
    spacesService: new SpacesService().start({ spacesClientService: clients }),
    hasOnlyDefaultSpace$: of(settings.config.maxSpaces === 1),
  };
};
