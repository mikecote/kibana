/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  KibanaRequest,
  SavedObjectsClientContract,
} from '@kbn/core/server';
import type { IScopedClusterClient } from '@kbn/core-elasticsearch-server';
import type {
  ApmDataAccessServices,
  ApmDataAccessPluginSetup,
} from '@kbn/apm-data-access-plugin/server';
import type { MlPluginSetup } from '@kbn/ml-plugin/server';
import type { WorkflowRuleRegistryServices } from '@kbn/rule-registry-plugin/server/task_types/create_workflow_alerts_client';
import type { SLOServerStart } from '@kbn/slo-plugin/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import { firstValueFrom } from 'rxjs';
import type { APMPluginSetupDependencies, APMPluginStartDependencies } from '../../types';
import { getApmEventClient } from '../../lib/helpers/get_apm_event_client';
import { getMlClient } from '../../lib/helpers/get_ml_client';
import { getApmAlertsClient } from '../../lib/helpers/get_apm_alerts_client';
import type { ApmAlertsClient } from '../../lib/helpers/get_apm_alerts_client';
import { getApmSloClient } from '../../lib/helpers/get_apm_slo_client';
import type { ApmSloClient } from '../../lib/helpers/get_apm_slo_client';
import { getRandomSamplerSeed } from '../../lib/helpers/get_random_sampler';

export interface ApmToolResources {
  apmEventClient: Awaited<ReturnType<typeof getApmEventClient>>;
  apmDataAccessServices: ApmDataAccessServices;
  randomSamplerSeed: number;
  mlClient: Awaited<ReturnType<typeof getMlClient>>;
  apmAlertsClient: ApmAlertsClient;
  /** SLO client; undefined when the SLO plugin is not available. */
  sloClient: ApmSloClient | undefined;
  esClient: IScopedClusterClient;
  soClient: SavedObjectsClientContract;
}

export async function buildApmToolResources({
  core,
  plugins,
  request,
  esClient,
}: {
  core: CoreSetup<APMPluginStartDependencies>;
  plugins: APMPluginSetupDependencies;
  request: KibanaRequest;
  esClient?: IScopedClusterClient;
}): Promise<ApmToolResources> {
  const [coreStart, pluginStart] = await core.getStartServices();
  return createApmToolResources({ coreStart, pluginStart, plugins, request, esClient });
}

export interface ApmToolCoreServices {
  elasticsearch: { client: Pick<CoreStart['elasticsearch']['client'], 'asScoped'> };
  savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
  uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient'>;
  security: { authc: Pick<CoreStart['security']['authc'], 'getCurrentUser'> };
}

export interface ApmToolSetupServices {
  apmDataAccess: Pick<ApmDataAccessPluginSetup, 'getApmIndices' | 'getServices'>;
  ml?: Pick<MlPluginSetup, 'mlSystemProvider' | 'anomalyDetectorsProvider' | 'modulesProvider'>;
}

export interface ApmToolStartServices {
  licensing: Pick<LicensingPluginStart, 'license$'>;
  ruleRegistry: WorkflowRuleRegistryServices;
  slo?: Pick<SLOServerStart, 'getSloClientWithRequest'>;
}

/** Builds native APM resources from the scoped services used by routes and workflow workers. */
export async function createApmToolResources({
  coreStart,
  pluginStart,
  plugins,
  request,
  esClient,
}: {
  coreStart: ApmToolCoreServices;
  pluginStart: ApmToolStartServices;
  plugins: ApmToolSetupServices;
  request: KibanaRequest;
  esClient?: IScopedClusterClient;
}): Promise<ApmToolResources> {
  const esScoped = esClient ?? coreStart.elasticsearch.client.asScoped(request);
  const soClient = coreStart.savedObjects.getScopedClient(request, { includedHiddenTypes: [] });
  const uiSettingsClient = coreStart.uiSettings.asScopedToClient(soClient);

  const licensingContext = firstValueFrom(pluginStart.licensing.license$).then((license) => ({
    license,
  }));

  const contextAdapter = {
    core: Promise.resolve({
      savedObjects: { client: soClient },
      uiSettings: { client: uiSettingsClient },
      elasticsearch: { client: esScoped },
    }),
    licensing: licensingContext,
  };

  const pluginsAdapter = {
    ml: plugins.ml
      ? {
          setup: plugins.ml,
        }
      : undefined,
    ruleRegistry: {
      start: async () => pluginStart.ruleRegistry,
    },
    slo: pluginStart.slo
      ? {
          start: async () => pluginStart.slo,
        }
      : undefined,
  };

  const apmEventClientPromise = getApmEventClient({
    context: contextAdapter,
    core: {
      start: async () => coreStart,
    },
    request,
    params: {
      query: {
        _inspect: false,
      },
    },
    getApmIndices: async () => {
      return plugins.apmDataAccess.getApmIndices(soClient);
    },
  });

  const randomSamplerSeed = getRandomSamplerSeed(coreStart, request);

  const mlClientPromise = getMlClient({
    plugins: pluginsAdapter,
    context: contextAdapter,
    request,
  }).catch(() => undefined);

  const apmAlertsClientPromise = getApmAlertsClient({
    context: contextAdapter,
    plugins: pluginsAdapter,
    request,
  });

  // SLO client degrades gracefully to undefined when the SLO plugin is absent.
  const sloClientPromise = getApmSloClient({
    plugins: pluginsAdapter,
    request,
  }).catch(() => undefined);

  const [apmEventClient, mlClient, apmAlertsClient, sloClient] = await Promise.all([
    apmEventClientPromise,
    mlClientPromise,
    apmAlertsClientPromise,
    sloClientPromise,
  ]);

  const apmDataAccessServices = plugins.apmDataAccess.getServices({ apmEventClient });

  return {
    apmEventClient,
    apmDataAccessServices,
    randomSamplerSeed,
    mlClient,
    apmAlertsClient,
    sloClient,
    esClient: esScoped,
    soClient,
  };
}
