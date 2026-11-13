/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';

import { FLEET_PACKAGE_METADATA_SETTINGS_ID } from '../package_metadata_task_process_settings';
import type { FleetPackageMetadataTaskProcessSettings } from '../package_metadata_task_process_settings';
import { parseExperimentalConfigValue } from '../../common/experimental_features';
import { getEncryptedSavedObjectTypes, getSavedObjectTypes } from '../saved_objects';
import { createFleetFieldsMetadataExtractors } from '../services/register_fields_metadata_extractors';
import type { FleetWorkflowRunServices } from '../services/run_time/workflow_run_services';
import { createFleetWorkflowRunServices } from '../services/run_time/workflow_run_services';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [FLEET_PACKAGE_METADATA_SETTINGS_ID],
    createSavedObjectTypes: (_encryption, settings) => {
      const metadata = settings[FLEET_PACKAGE_METADATA_SETTINGS_ID] as
        | FleetPackageMetadataTaskProcessSettings
        | undefined;
      if (!metadata) return [];
      const { config } = metadata;
      const features = parseExperimentalConfigValue(
        config.enableExperimental ?? [],
        config.experimentalFeatures ?? {}
      );
      return Object.values(getSavedObjectTypes({ useSpaceAwareness: features.useSpaceAwareness }));
    },
    encryptedSavedObjectTypes: getEncryptedSavedObjectTypes(),
  },
  provides: {
    'fleet.runServices': ({ host, settings }) => {
      const metadata = settings[FLEET_PACKAGE_METADATA_SETTINGS_ID] as
        | FleetPackageMetadataTaskProcessSettings
        | undefined;
      if (!metadata)
        throw new Error(
          `Fleet workflow services require the ${FLEET_PACKAGE_METADATA_SETTINGS_ID} snapshot`
        );
      return createFleetWorkflowRunServices(host as TaskHost, metadata);
    },
    'fieldsMetadata.extractors.fleet': ({ host, services }) => {
      if (!services) throw new Error('Fleet field metadata requires native workflow services');
      const fleet = services.getService<FleetWorkflowRunServices>('fleet.runServices');
      const taskHost = host as TaskHost;
      return createFleetFieldsMetadataExtractors({
        getPackageService: async () => (await fleet.getServices()).packageService.asInternalUser,
        getLogger: () => taskHost.logger.get('fleet'),
      });
    },
  },
  register: () => {},
};
