/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import { dataViewsServiceFactory } from '@kbn/data-views-plugin/server/data_views_service_factory';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { createWorkflowSpacesServices } from '@kbn/workflows-extensions/server/spaces_runtime_contribution';
import { createDataViewsCapabilities } from './create_data_views_capabilities';
import type { createStandaloneFieldFormats } from './field_formats';
import type { AlertingRunSettings } from '../rule_run_settings';
import {
  RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID,
  type RuleDataViewsCapabilitiesSettings,
} from '../rule_data_views_settings';

/** Builds rule data views with native per-request Security and optional Spaces capabilities. */
export const createRuleDataViews = (
  host: TaskHost,
  runSettings: AlertingRunSettings,
  fieldFormats: ReturnType<typeof createStandaloneFieldFormats>
): Pick<DataViewsServerPluginStart, 'dataViewsServiceFactory'> => {
  const { uiSettings, logger } = host;
  if (!uiSettings) throw new Error('Rule data views require native Core UI settings');
  let capabilities: ReturnType<typeof createDataViewsCapabilities> | undefined;
  return {
    dataViewsServiceFactory: dataViewsServiceFactory({
      logger,
      uiSettings,
      fieldFormats,
      capabilities: {
        resolveCapabilities: async (request, options) => {
          if (!capabilities) {
            const snapshot = host.settings?.[RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID] as
              | RuleDataViewsCapabilitiesSettings
              | undefined;
            const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
            if (!snapshot || !security)
              throw new Error(
                'Rule data-view capabilities require current feature settings and native Security'
              );
            const spaces = snapshot.spacesEnabled ? createWorkflowSpacesServices(host) : undefined;
            capabilities = createDataViewsCapabilities({
              features: snapshot.features,
              authz: security.authz,
              getCurrentUser: security.authc.getCurrentUser,
              getActiveSpace: spaces?.spacesService.getActiveSpace,
              logger,
            });
          }
          return capabilities.resolveCapabilities(request, options);
        },
      },
      scriptedFieldsEnabled: runSettings.dataViews.scriptedFieldsEnabled,
      rollupsEnabled: runSettings.search?.rollupsEnabled ?? false,
    }),
  };
};
