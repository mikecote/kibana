/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { CoreSetup, KibanaRequest } from '@kbn/core/server';
import type {
  SyntheticsPluginsSetupDependencies,
  SyntheticsPluginsStartDependencies,
} from '../types';
import { MonitorConfigRepository } from '../services/monitor_config_repository';
import { ConfigKey } from '../../common/runtime_types';

export function registerDataProviders({
  core,
  plugins,
}: {
  core: CoreSetup;
  plugins: SyntheticsPluginsSetupDependencies;
}) {
  const { observabilityAgentBuilder } = plugins;
  if (!observabilityAgentBuilder) {
    return;
  }

  observabilityAgentBuilder.registerDataProvider(
    'syntheticsMonitorDetails',
    createSyntheticsMonitorDetailsDataProvider(async (request) => {
      const [coreStart, pluginsStart] = await (
        core as CoreSetup<SyntheticsPluginsStartDependencies>
      ).getStartServices();
      return new MonitorConfigRepository(
        coreStart.savedObjects.getScopedClient(request),
        pluginsStart.encryptedSavedObjects.getClient()
      );
    }),
    { owner: 'synthetics' }
  );
}

/** Shares the native monitor lookup and public field selection between Kibana and workflow workers. */
export const createSyntheticsMonitorDetailsDataProvider =
  (
    getRepository: (request: KibanaRequest) => Promise<Pick<MonitorConfigRepository, 'get'>>
  ): ObservabilityAgentBuilderDataRegistryTypes['syntheticsMonitorDetails'] =>
  async ({ request, configId }) => {
    const repository = await getRepository(request);
    const monitor = await repository.get(configId);
    const { attributes } = monitor;
    return {
      id: monitor.id,
      name: attributes[ConfigKey.NAME],
      type: attributes[ConfigKey.MONITOR_TYPE],
      enabled: attributes[ConfigKey.ENABLED],
      schedule: attributes[ConfigKey.SCHEDULE],
      locations: attributes[ConfigKey.LOCATIONS],
      tags: attributes[ConfigKey.TAGS],
    };
  };
