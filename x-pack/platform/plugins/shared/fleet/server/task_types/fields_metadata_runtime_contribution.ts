/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';

import { PACKAGES_SAVED_OBJECT_TYPE, ASSETS_SAVED_OBJECT_TYPE } from '../constants';
import { FLEET_PACKAGE_METADATA_SETTINGS_ID } from '../package_metadata_task_process_settings';
import type { FleetPackageMetadataTaskProcessSettings } from '../package_metadata_task_process_settings';
import { getSavedObjectTypes } from '../saved_objects';
import { createFleetPackageMetadataRunServices } from '../services/run_time/package_metadata_run_services';

const savedObjects = getSavedObjectTypes();

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [FLEET_PACKAGE_METADATA_SETTINGS_ID],
    savedObjectTypes: [
      savedObjects[PACKAGES_SAVED_OBJECT_TYPE],
      savedObjects[ASSETS_SAVED_OBJECT_TYPE],
    ],
  },
  provides: {
    'fieldsMetadata.extractors.fleet': ({ host, settings }) => {
      const metadata = settings[FLEET_PACKAGE_METADATA_SETTINGS_ID] as
        | FleetPackageMetadataTaskProcessSettings
        | undefined;
      if (!metadata) {
        throw new Error(
          `Fleet field metadata requires the ${FLEET_PACKAGE_METADATA_SETTINGS_ID} snapshot`
        );
      }
      return createFleetPackageMetadataRunServices(host as TaskHost, metadata);
    },
  },
  register: () => {},
};
