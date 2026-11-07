/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  Logger,
  KibanaRequest,
  IScopedClusterClient,
  IUiSettingsClient,
  SavedObjectsClientContract,
} from '@kbn/core/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import type { ApmDataAccessPluginSetup } from '@kbn/apm-data-access-plugin/server';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { InfraMetricsClient } from '../lib/helpers/get_infra_metrics_client';
import type { InfraAlertsClient } from '../lib/helpers/get_infra_alerts_client';
import type { ApmDataAccessServicesWrapper } from '../lib/helpers/get_apm_data_access_client';
import type {
  InfraServerPluginSetupDeps,
  InfraServerPluginStartDeps,
} from '../lib/adapters/framework';
import { getHosts } from '../routes/infra/lib/host/get_hosts';
import type { InfraBackendLibs } from '../lib/infra_types';
import { getInfraMetricsClient } from '../lib/helpers/get_infra_metrics_client';
import { createInfraAlertsClient } from '../lib/helpers/get_infra_alerts_client';
import type { InfraToolRequestServices } from '../utils/get_infra_request_handler_context';
import { callWithRequest } from '../lib/adapters/framework/call_with_request';
import { getPreferredSchema } from '../lib/helpers/get_preferred_schema';
import { getInfraRequestHandlerContext } from '../utils/get_infra_request_handler_context';
import { getApmDataAccessClient } from '../lib/helpers/get_apm_data_access_client';

const DEFAULT_HOST_METRICS = [
  'cpuV2',
  'memory',
  'memoryFree',
  'diskSpaceUsage',
  'normalizedLoad1m',
] as const;

export function registerDataProviders({
  core,
  plugins,
  libs,
  logger,
}: {
  core: CoreSetup<InfraServerPluginStartDeps>;
  plugins: InfraServerPluginSetupDeps;
  libs: InfraBackendLibs;
  logger: Logger;
}) {
  const { observabilityAgentBuilder } = plugins;
  if (!observabilityAgentBuilder) {
    return;
  }

  registerNativeInfraDataProviders({
    registerDataProvider: (id, provider) =>
      observabilityAgentBuilder.registerDataProvider(id, provider, { owner: 'infra' }),
    getResources: async (request) => {
      const coreContext = await core.createRequestHandlerContext(request);
      const [, { ruleRegistry }] = await libs.getStartServices();
      return createInfraToolResources({
        coreContext,
        request,
        plugins,
        ruleRegistry,
        apmDataAccess: libs.plugins.apmDataAccess.setup,
      });
    },
    logger,
  });
}

/** Registers native Infrastructure data providers over a per-request resource factory. */
export function registerNativeInfraDataProviders({
  registerDataProvider,
  getResources,
  logger,
}: {
  registerDataProvider: (
    id: 'infraHosts',
    provider: ObservabilityAgentBuilderDataRegistryTypes['infraHosts']
  ) => void;
  getResources: (request: KibanaRequest) => ReturnType<typeof createInfraToolResources>;
  logger: Logger;
}): void {
  registerDataProvider('infraHosts', async ({ request, from, to, limit, query }) => {
    const infraToolResources = await getResources(request);

    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();

    const { preferredSchema } = await getPreferredSchema({
      infraMetricsClient: infraToolResources.infraMetricsClient,
      dataSource: 'host',
      from: fromMs,
      to: toMs,
    });

    if (!preferredSchema) {
      logger.info('Could not determine preferred schema ');
      return { nodes: [] };
    }

    const result = await getHosts({
      from: fromMs,
      to: toMs,
      metrics: [...DEFAULT_HOST_METRICS],
      limit,
      query,
      alertsClient: infraToolResources.alertsClient,
      infraMetricsClient: infraToolResources.infraMetricsClient,
      apmDataAccessServices: infraToolResources.apmDataAccessServices,
      schema: preferredSchema,
    });

    return result;
  });
}

export interface InfraToolResources {
  infraMetricsClient: InfraMetricsClient;
  alertsClient: InfraAlertsClient;
  apmDataAccessServices: ApmDataAccessServicesWrapper;
}

/** Builds Infrastructure resources with the native search, metrics and authorization services. */
export async function createInfraToolResources({
  coreContext,
  request,
  plugins,
  ruleRegistry,
  apmDataAccess,
}: {
  coreContext: {
    savedObjects: { client: SavedObjectsClientContract };
    uiSettings: { client: IUiSettingsClient };
    elasticsearch: { client: IScopedClusterClient };
  };
  request: KibanaRequest;
  plugins: InfraToolRequestServices;
  ruleRegistry: WorkflowRuleRegistryServices;
  apmDataAccess: Pick<ApmDataAccessPluginSetup, 'getApmIndices' | 'getServices'>;
}): Promise<InfraToolResources> {
  const infraContext = await getInfraRequestHandlerContext({ coreContext, request, plugins });
  const context = { core: Promise.resolve(coreContext), infra: Promise.resolve(infraContext) };
  const infraMetricsClient = await getInfraMetricsClient({
    libs: { framework: { callWithRequest } },
    context,
    request,
  });
  const alertsClient = await createInfraAlertsClient({ ruleRegistry, request });
  const apmDataAccessServices = await getApmDataAccessClient({
    libs: { plugins: { apmDataAccess: { setup: apmDataAccess } } },
    context,
    request,
  }).getServices();
  return { infraMetricsClient, alertsClient, apmDataAccessServices };
}
