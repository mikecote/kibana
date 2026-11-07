/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { FieldsMetadataServerStart } from '@kbn/fields-metadata-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { createFieldsMetadataCapabilities } from '../../task_types/create_fields_metadata_capabilities';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [SPACES_TASK_PROCESS_SETTINGS_ID] },
  register: (registry, { host, services }) => {
    const taskHost = host as TaskHost;
    const security = taskHost.plugins?.security as SecurityTaskPluginStart | undefined;
    const settings = taskHost.settings?.[SPACES_TASK_PROCESS_SETTINGS_ID] as
      | SpacesTaskProcessSettings
      | undefined;
    if (!security || !settings || !services)
      throw new Error('The capability fixture requires Security and Spaces settings');
    const spaces = services.getService<SpacesPluginStart>('spaces');
    const fieldsMetadata = services.getService<FieldsMetadataServerStart>('fieldsMetadata');
    const getCapabilities = createFieldsMetadataCapabilities({
      features: settings.features,
      authz: security.authz,
      getCurrentUser: security.authc.getCurrentUser,
      getActiveSpace: spaces.spacesService.getActiveSpace,
      logger: taskHost.logger.get('fields-metadata-capabilities'),
    });
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.fields_metadata.capabilities',
        label: 'Resolve metadata privileges',
        description: 'Resolve native Fleet privileges for the current task identity and space',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          fleet: z.boolean(),
          fleetv2: z.boolean(),
          disabledFeatures: z.array(z.string()),
          ecsSource: z.string(),
          fipsEnabled: z.boolean(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const space = await spaces.spacesService.getActiveSpace(request);
          const capabilities = await getCapabilities(request);
          const client = await fieldsMetadata.getClient(request);
          const field = await client.getByName('host.name');
          if (!field) throw new Error('The native metadata client did not return host.name');
          const { source } = field.toPlain();
          if (!source)
            throw new Error('The native metadata client did not return the field source');
          return {
            output: {
              fleet: capabilities.fleet?.read === true,
              fleetv2: capabilities.fleetv2?.read === true,
              disabledFeatures: space.disabledFeatures,
              ecsSource: source,
              fipsEnabled: taskHost.security.fips.isEnabled(),
            },
          };
        },
      })
    );
  },
};
