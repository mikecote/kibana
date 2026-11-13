/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ApmSourcesAccessPluginSetup } from '@kbn/apm-sources-access-plugin/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createApmDataAccessServices } from '../create_apm_data_access_services';
import { APM_DATA_TASK_PROCESS_SETTINGS_ID } from './apm_data_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [APM_DATA_TASK_PROCESS_SETTINGS_ID] },
  provides: {
    'apmDataAccess.setup': ({ services, settings }) => {
      if (!settings[APM_DATA_TASK_PROCESS_SETTINGS_ID])
        throw new Error('APM data access is not enabled in the dispatching Kibana');
      if (!services) throw new Error('APM data access requires workflow execution services');
      return createApmDataAccessServices(
        services.getService<ApmSourcesAccessPluginSetup>('apmSourcesAccess.setup')
      );
    },
  },
  register: () => {},
};
