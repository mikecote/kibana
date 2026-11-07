/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { MetricsDataDefaultIndicesProvider } from '@kbn/metrics-data-access-plugin/server';
import { createInfraSources } from '../lib/alerting/create_infra_alerting_libs';
import { infraSourceConfigurationSavedObjectType } from '../lib/sources/saved_object_type';

export const contribution: WorkflowStepsContribution = {
  declares: { savedObjectTypes: [infraSourceConfigurationSavedObjectType] },
  provides: {
    'metricsDataAccess.defaultIndices.infra': (): MetricsDataDefaultIndicesProvider => ({
      configure: (metricsClient) => {
        createInfraSources({ metricsClient });
      },
    }),
  },
  register: () => {},
};
