/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AgentBuilderContributionServices } from '@kbn/agent-builder-server';
import { ObservabilityAgentBuilderDataRegistry } from '../data_registry/data_registry';
import type { ObservabilityDataRegistryClient } from '../data_registry/data_registry';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '../data_registry/data_registry_types';
import type { ObservabilityAgentBuilderTaskProcessSettings } from './observability_agent_builder_task_process_settings';

/** Binds the dispatch's data-provider registrations to their native owning services on first use. */
export const createObservabilityTaskDataRegistry = ({
  snapshot,
  getService,
  logger,
}: {
  snapshot: Pick<ObservabilityAgentBuilderTaskProcessSettings, 'dataProviders'>;
  getService: AgentBuilderContributionServices['getService'];
  logger: Logger;
}): ObservabilityDataRegistryClient => {
  let nativeRegistry: ObservabilityAgentBuilderDataRegistry | undefined;
  const getRegistry = () => {
    if (nativeRegistry) return nativeRegistry;
    const registry = new ObservabilityAgentBuilderDataRegistry(logger);
    for (const { id, owner } of snapshot.dataProviders) {
      if (!owner) throw new Error(`Observability data provider ${id} has no native owner`);
      const provider = getService<Partial<ObservabilityAgentBuilderDataRegistryTypes>>(
        `observabilityAgentBuilder.dataProviders.${owner}`
      )[id];
      if (!provider)
        throw new Error(`Observability data provider ${id} was not contributed by ${owner}`);
      registry.registerDataProvider(id, provider, { owner });
    }
    nativeRegistry = registry;
    return registry;
  };
  return {
    getData: (id, params) => getRegistry().getData(id, params),
  };
};
