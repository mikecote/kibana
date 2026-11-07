/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { MetricsDataPluginSetup } from '../plugin';
import { MetricsDataClient } from '../client';
import { metricsDataSourceSavedObjectType } from '../saved_objects/metrics_data_source';
import {
  METRICS_DATA_TASK_PROCESS_SETTINGS_ID,
  type MetricsDataTaskProcessSettings,
  type MetricsDataDefaultIndicesProvider,
} from './metrics_data_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [METRICS_DATA_TASK_PROCESS_SETTINGS_ID],
    savedObjectTypes: [metricsDataSourceSavedObjectType],
  },
  provides: {
    'metricsDataAccess.setup': ({ settings, services }): MetricsDataPluginSetup => {
      const snapshot = settings[METRICS_DATA_TASK_PROCESS_SETTINGS_ID] as
        | MetricsDataTaskProcessSettings
        | undefined;
      if (!snapshot)
        throw new Error('Metrics data access requires its native registration snapshot');
      const client = new MetricsDataClient();
      if (snapshot.defaultHandler.installed) {
        const { owner } = snapshot.defaultHandler;
        if (!owner) throw new Error('The native metric indices resolver has no task-process owner');
        if (!services) throw new Error('Metrics data access requires workflow execution services');
        services
          .getService<MetricsDataDefaultIndicesProvider>(
            `metricsDataAccess.defaultIndices.${owner}`
          )
          .configure(client);
        const registration = client.getDefaultMetricIndicesHandlerRegistration();
        if (!registration.installed || registration.owner !== owner) {
          throw new Error('The metric indices resolver differs from the native registration');
        }
      }
      return { client };
    },
  },
  register: () => {},
};
