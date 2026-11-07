/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger } from '@kbn/core/server';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { SLOPluginSetupDependencies, SLOPluginStartDependencies } from '../types';
import type { SLOServerStart } from '../types';
import { createScopedSloClient } from '../client/create_scoped_slo_client';

export function registerDataProviders({
  core,
  plugins,
  logger,
}: {
  core: CoreSetup<SLOPluginStartDependencies>;
  plugins: SLOPluginSetupDependencies;
  logger: Logger;
}) {
  const { observabilityAgentBuilder } = plugins;
  if (!observabilityAgentBuilder) {
    return;
  }

  observabilityAgentBuilder.registerDataProvider(
    'sloDetails',
    createSloDetailsDataProvider(async (request) => {
      const [coreStart, pluginStart] = await core.getStartServices();
      return createScopedSloClient({
        savedObjects: coreStart.savedObjects,
        elasticsearch: coreStart.elasticsearch,
        getSpaceId: async (scopedRequest) =>
          (await pluginStart.spaces?.spacesService.getActiveSpace(scopedRequest))?.id ?? 'default',
        logger,
      })(request);
    }),
    { owner: 'slo' }
  );
}

/** Builds the SLO attachment's data provider from the shared native scoped client. */
export const createSloDetailsDataProvider =
  (
    getClient: SLOServerStart['getSloClientWithRequest']
  ): ObservabilityAgentBuilderDataRegistryTypes['sloDetails'] =>
  async ({ request, sloId, sloInstanceId, remoteName }) => {
    const client = await getClient(request);
    return client.getSlo(sloId, { instanceId: sloInstanceId, remoteName });
  };
