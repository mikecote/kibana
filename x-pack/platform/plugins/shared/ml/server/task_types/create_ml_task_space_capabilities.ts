/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CapabilitiesSwitcher } from '@kbn/core/server';
import { KibanaFeature } from '@kbn/features-plugin/server';
import { createSpacesCapabilitiesSwitcher } from '@kbn/spaces-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';

/** Builds the native space feature gate without reading execution services during registration. */
export const createMlTaskSpaceCapabilities =
  (
    host: Pick<TaskHost, 'logger'>,
    getSpaces: () => Promise<{
      spacesService: Pick<SpacesPluginStart['spacesService'], 'getActiveSpace'>;
    }>,
    getSettings: () => SpacesTaskProcessSettings
  ): CapabilitiesSwitcher =>
  async (request, capabilities, useDefaultCapabilities) => {
    const settings = getSettings();
    const spaces = await getSpaces();
    return createSpacesCapabilitiesSwitcher({
      logger: host.logger,
      getActiveSpace: (scopedRequest) => spaces.spacesService.getActiveSpace(scopedRequest),
      getKibanaFeatures: async () => settings.features.map((feature) => new KibanaFeature(feature)),
    })(request, capabilities, useDefaultCapabilities);
  };
