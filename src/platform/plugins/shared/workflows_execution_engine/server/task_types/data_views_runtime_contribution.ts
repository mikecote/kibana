/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createDataViewsCapabilities } from '@kbn/alerting-plugin/server/task_types/standalone/create_data_views_capabilities';
import { createStandaloneFieldFormats } from '@kbn/alerting-plugin/server/task_types/standalone/field_formats';
import {
  getSearchMaxConcurrentShardUiSettings,
  searchIncludeFrozenUiSettings,
} from '@kbn/data-plugin/server/ui_settings';
import {
  DATA_VIEWS_TASK_PROCESS_SETTINGS_ID,
  dataViewSavedObjectType,
  dataViewServiceUiSettings,
  dataViewsServiceFactory,
  registerDataViewsUiSettings,
} from '@kbn/data-views-plugin/server';
import type {
  DataViewsServerPluginStart,
  DataViewsTaskProcessSettings,
} from '@kbn/data-views-plugin/server';
import { getUiSettings as getFieldFormatUiSettings } from '@kbn/field-formats-plugin/server/ui_settings';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { DataSearchTaskProcessSettings } from './data_search_task_process_settings';
import { DATA_SEARCH_TASK_PROCESS_SETTINGS_ID } from './data_search_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: {
    savedObjectTypes: [dataViewSavedObjectType],
    settings: [
      DATA_VIEWS_TASK_PROCESS_SETTINGS_ID,
      SPACES_TASK_PROCESS_SETTINGS_ID,
      DATA_SEARCH_TASK_PROCESS_SETTINGS_ID,
    ],
    registerUiSettings: (registry, settings) => {
      const search = settings[DATA_SEARCH_TASK_PROCESS_SETTINGS_ID] as
        | DataSearchTaskProcessSettings
        | undefined;
      if (search) {
        registry.register(searchIncludeFrozenUiSettings);
        registry.register(getSearchMaxConcurrentShardUiSettings(search.multiSearchDocLink));
      }
      const snapshot = settings[DATA_VIEWS_TASK_PROCESS_SETTINGS_ID] as
        | DataViewsTaskProcessSettings
        | undefined;
      if (!snapshot) return;
      registerDataViewsUiSettings(registry, snapshot);
      registry.register(getFieldFormatUiSettings());
      registry.register(dataViewServiceUiSettings);
    },
  },
  provides: {
    dataViews: ({ host: taskHost, settings, services }): DataViewsServerPluginStart => {
      const snapshot = settings[DATA_VIEWS_TASK_PROCESS_SETTINGS_ID] as
        | DataViewsTaskProcessSettings
        | undefined;
      const spacesSnapshot = settings[SPACES_TASK_PROCESS_SETTINGS_ID] as
        | SpacesTaskProcessSettings
        | undefined;
      const host = taskHost as TaskHost;
      const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
      if (!snapshot) throw new Error('Data views are not enabled in the dispatching Kibana');
      if (!spacesSnapshot || !security || !host.uiSettings || !services)
        throw new Error('Data views require native UI settings, Security and Spaces services');
      const spaces = services.getService<SpacesPluginStart>('spaces');
      return {
        getScriptedFieldsEnabled: () => snapshot.scriptedFieldsEnabled,
        dataViewsServiceFactory: dataViewsServiceFactory({
          logger: host.logger.get('dataViews'),
          uiSettings: host.uiSettings,
          fieldFormats: createStandaloneFieldFormats(),
          capabilities: createDataViewsCapabilities({
            features: spacesSnapshot.features,
            authz: security.authz,
            getCurrentUser: security.authc.getCurrentUser,
            getActiveSpace: spaces.spacesService.getActiveSpace,
            logger: host.logger.get('dataViews', 'capabilities'),
          }),
          scriptedFieldsEnabled: snapshot.scriptedFieldsEnabled,
          rollupsEnabled: snapshot.rollupsEnabled,
        }),
      };
    },
  },
  register: () => {},
};
