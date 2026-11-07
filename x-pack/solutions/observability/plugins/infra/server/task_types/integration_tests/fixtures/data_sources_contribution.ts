/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { ApmDataAccessPluginSetup } from '@kbn/apm-data-access-plugin/server';
import type { LogsDataAccessPluginStart } from '@kbn/logs-data-access-plugin/server';
import type { MetricsDataPluginSetup } from '@kbn/metrics-data-access-plugin/server';
import { metricsDataSourceSavedObjectName } from '@kbn/metrics-data-access-plugin/server';
import { createInfraSources } from '../../../lib/alerting/create_infra_alerting_libs';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, services }) => {
    if (!services) throw new Error('The data sources fixture requires execution services');
    const taskHost = host as TaskHost;
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.observability.data_sources',
        label: 'Resolve native data sources',
        description: 'Read the current native APM, logs and metrics source configuration',
        category: StepCategory.Kibana,
        inputSchema: z.object({
          mutation: z.enum(['sources', 'metric_override', 'clear_override']).optional(),
        }),
        outputSchema: z.object({
          apmTransaction: z.string(),
          apmMetric: z.string(),
          metrics: z.string(),
          logs: z.array(z.string()),
          defaultHandlerOwner: z.string().optional(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const client = taskHost.savedObjects.getScopedClient(request);
          const apm = services.getService<ApmDataAccessPluginSetup>('apmDataAccess.setup');
          const logs = services.getService<LogsDataAccessPluginStart>('logsDataAccess');
          const metrics = services.getService<MetricsDataPluginSetup>('metricsDataAccess.setup');
          const logSources =
            await logs.services.logSourcesServiceFactory.getScopedLogSourcesService(request);
          if (context.input.mutation === 'sources') {
            await client.create(
              'apm-indices',
              { apmIndices: { transaction: 'updated-apm-*' }, isSpaceAware: true },
              { id: 'apm-indices', overwrite: true }
            );
            await logSources.setLogSources([{ indexPattern: 'updated-logs-*' }]);
            await createInfraSources({ metricsClient: metrics.client }).updateSourceConfiguration(
              client,
              'default',
              { metricAlias: 'updated-infra-*' }
            );
            await client.delete(metricsDataSourceSavedObjectName, 'default');
          } else if (context.input.mutation === 'metric_override') {
            await metrics.client.updateMetricIndices({
              savedObjectsClient: client,
              metricIndices: 'explicit-metrics-*',
            });
          } else if (context.input.mutation === 'clear_override') {
            await client.delete(metricsDataSourceSavedObjectName, 'default');
          }
          const indices = await apm.getApmIndices(client);
          return {
            output: {
              apmTransaction: indices.transaction,
              apmMetric: indices.metric,
              metrics: await metrics.client.getMetricIndices({ savedObjectsClient: client }),
              logs: (await logSources.getLogSources()).map(({ indexPattern }) => indexPattern),
              defaultHandlerOwner:
                metrics.client.getDefaultMetricIndicesHandlerRegistration().owner,
            },
          };
        },
      })
    );
  },
};
