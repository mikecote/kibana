/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { FIELDS_METADATA_TASK_PROCESS_SETTINGS_ID } from '@kbn/fields-metadata-plugin/server';
import type {
  FieldsMetadataExtractors,
  FieldsMetadataServerStart,
  FieldsMetadataTaskProcessSettings,
} from '@kbn/fields-metadata-plugin/server';
import { FieldsMetadataService } from '@kbn/fields-metadata-plugin/server/services/fields_metadata/fields_metadata_service';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type {
  WorkflowStepsContribution,
  WorkflowStepsContributionServices,
} from '@kbn/workflows-extensions/server';
import { createFieldsMetadataCapabilities } from './create_fields_metadata_capabilities';

/** Creates native metadata clients with the exact extractor registrations of the dispatching Kibana. */
export const createFieldsMetadataRunServices = (
  taskHost: TaskHost,
  getService: WorkflowStepsContributionServices['getService']
): FieldsMetadataServerStart => {
  const metadata = taskHost.settings?.[FIELDS_METADATA_TASK_PROCESS_SETTINGS_ID] as
    | FieldsMetadataTaskProcessSettings
    | undefined;
  const spaces = taskHost.settings?.[SPACES_TASK_PROCESS_SETTINGS_ID] as
    | SpacesTaskProcessSettings
    | undefined;
  const security = taskHost.plugins?.security as SecurityTaskPluginStart | undefined;
  if (!metadata || !spaces || !security) {
    throw new Error(
      'Field metadata execution requires its native registry, Spaces and Security services'
    );
  }
  const logger = taskHost.logger.get('fields-metadata');
  const service = new FieldsMetadataService(logger);
  const registry = service.setup();
  const getProvider = (id: string): FieldsMetadataExtractors =>
    getService<FieldsMetadataExtractors>(`fieldsMetadata.extractors.${id}`);
  if (metadata.integrationFieldsExtractor) {
    const id = metadata.integrationFieldsExtractor;
    const extractor = getProvider(id).integrationFieldsExtractor;
    if (!extractor)
      throw new Error(`Field metadata provider ${id} has no integration field extractor`);
    registry.registerIntegrationFieldsExtractor(extractor, id);
  }
  if (metadata.integrationListExtractor) {
    const id = metadata.integrationListExtractor;
    const extractor = getProvider(id).integrationListExtractor;
    if (!extractor)
      throw new Error(`Field metadata provider ${id} has no integration list extractor`);
    registry.registerIntegrationListExtractor(extractor, id);
  }
  if (metadata.streamsFieldsExtractor) {
    const id = metadata.streamsFieldsExtractor;
    const extractor = getProvider(id).streamsFieldsExtractor;
    if (!extractor) throw new Error(`Field metadata provider ${id} has no stream field extractor`);
    registry.registerStreamsFieldsExtractor(extractor, id);
  }
  const spacesService = getService<SpacesPluginStart>('spaces');
  return service.startFromServices({
    elasticsearch: { client: taskHost.elasticsearch },
    getCapabilities: createFieldsMetadataCapabilities({
      features: spaces.features,
      authz: security.authz,
      getCurrentUser: security.authc.getCurrentUser,
      getActiveSpace: spacesService.spacesService.getActiveSpace,
      logger,
    }),
  });
};

export const contribution: WorkflowStepsContribution = {
  provides: {
    fieldsMetadata: ({ host, services }) => {
      if (!services) throw new Error('Field metadata execution requires workflow services');
      return createFieldsMetadataRunServices(host as TaskHost, services.getService);
    },
  },
  register: () => {},
};
