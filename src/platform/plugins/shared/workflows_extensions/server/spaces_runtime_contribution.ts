/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { setupSpacesClient } from '@kbn/security-plugin/server/spaces/setup_spaces_client';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { createSpacesRunServices } from '@kbn/spaces-plugin/server/create_spaces_run_services';
import { getSpaceSavedObjectType } from '@kbn/spaces-plugin/server/saved_objects/saved_objects_service';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from './create_server_step_registry';

/** Builds the spaces service with the same security wrapper that Kibana installs. */
export const createWorkflowSpacesServices = (host: TaskHost): SpacesPluginStart => {
  const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
  if (!security) throw new Error('The spaces runtime requires security services');
  return createSpacesRunServices(host, (spacesClient) =>
    setupSpacesClient({
      spaces: { spacesClient },
      authz: security.authz,
      audit: security.audit,
      getCurrentUser: security.authc.getCurrentUser,
      getTypeRegistry: host.savedObjects.getTypeRegistry,
    })
  );
};

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [SPACES_TASK_PROCESS_SETTINGS_ID],
    savedObjectTypes: [getSpaceSavedObjectType()],
  },
  provides: {
    spaces: ({ host }) => createWorkflowSpacesServices(host as TaskHost),
  },
  register: () => {},
};
