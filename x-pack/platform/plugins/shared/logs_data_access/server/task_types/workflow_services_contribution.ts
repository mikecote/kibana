/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { LogsDataAccessPluginStart } from '../plugin';
import { uiSettings } from '../../common/ui_settings';
import { registerServices } from '../services/register_services';
import { LOGS_DATA_TASK_PROCESS_SETTINGS_ID } from './logs_data_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [LOGS_DATA_TASK_PROCESS_SETTINGS_ID], uiSettings: [uiSettings] },
  provides: {
    logsDataAccess: ({ host, settings }): LogsDataAccessPluginStart => {
      if (!settings[LOGS_DATA_TASK_PROCESS_SETTINGS_ID])
        throw new Error('Logs data access is not enabled in the dispatching Kibana');
      const { savedObjects, uiSettings: settingsService, logger } = host as TaskHost;
      if (!settingsService) throw new Error('Logs data access requires native UI settings');
      return {
        services: registerServices({
          logger: logger.get('logsDataAccess'),
          deps: { savedObjects, uiSettings: settingsService },
        }),
      };
    },
  },
  register: () => {},
};
