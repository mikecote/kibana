/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  SavedObjectsClientContract,
  IUiSettingsClient,
  KibanaRequest,
} from '@kbn/core/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { MetricsDataClient } from '@kbn/metrics-data-access-plugin/server';
import type { MlPluginSetup } from '@kbn/ml-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { InfraPluginRequestHandlerContext } from '../types';

export interface InfraToolRequestServices {
  metricsDataAccess: { client: Pick<MetricsDataClient, 'getMetricIndices'> };
  ml?: Pick<MlPluginSetup, 'mlSystemProvider' | 'anomalyDetectorsProvider'>;
  spaces?: { spacesService: Pick<SpacesPluginStart['spacesService'], 'getSpaceId'> };
}

export async function getInfraRequestHandlerContext({
  coreContext,
  request,
  plugins,
}: {
  coreContext: {
    savedObjects: { client: SavedObjectsClientContract };
    uiSettings: { client: IUiSettingsClient };
  };
  request: KibanaRequest;
  plugins: InfraToolRequestServices;
}): Promise<InfraPluginRequestHandlerContext['infra']> {
  const savedObjectsClient = coreContext.savedObjects.client;
  const uiSettingsClient = coreContext.uiSettings.client;
  const metricsClient = plugins.metricsDataAccess.client;

  const mlSystem = plugins.ml?.mlSystemProvider(request, savedObjectsClient);
  const mlAnomalyDetectors = plugins.ml?.anomalyDetectorsProvider(request, savedObjectsClient);
  const spaceId = plugins.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID;

  const getMetricsIndices = async () => {
    return metricsClient.getMetricIndices({
      savedObjectsClient,
    });
  };

  return {
    mlAnomalyDetectors,
    mlSystem,
    spaceId,
    savedObjectsClient,
    uiSettingsClient,
    getMetricsIndices,
  };
}
