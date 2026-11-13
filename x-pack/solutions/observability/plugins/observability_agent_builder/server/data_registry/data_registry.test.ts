/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { ObservabilityAgentBuilderDataRegistry } from './data_registry';
import type { ObservabilityAgentBuilderDataRegistryTypes } from './data_registry_types';

describe('observability provider ownership', () => {
  it('tracks the active provider and clears earlier ownership when an unannotated provider replaces it', async () => {
    const registry = new ObservabilityAgentBuilderDataRegistry(loggingSystemMock.createLogger());
    const original: ObservabilityAgentBuilderDataRegistryTypes['infraHosts'] = async () => ({
      nodes: [],
    });
    const node = { name: 'replacement-host', metrics: [], metadata: [], hasSystemMetrics: true };
    const replacement: ObservabilityAgentBuilderDataRegistryTypes['infraHosts'] = async () => ({
      nodes: [node],
    });
    registry.registerDataProvider('infraHosts', original, { owner: 'infra' });
    const snapshot = registry.getRegistrations();
    expect(snapshot).toEqual([{ id: 'infraHosts', owner: 'infra' }]);
    snapshot[0].owner = 'mutated';
    expect(registry.getRegistrations()).toEqual([{ id: 'infraHosts', owner: 'infra' }]);
    registry.registerDataProvider('infraHosts', replacement);
    expect(registry.getRegistrations()).toEqual([{ id: 'infraHosts' }]);
    expect(
      await registry.getData('infraHosts', {
        request: httpServerMock.createKibanaRequest(),
        from: '2026-01-01',
        to: '2026-01-02',
        limit: 10,
        query: undefined,
      })
    ).toEqual({ nodes: [node] });
    registry.registerDataProvider('infraHosts', original, { owner: 'infra' });
    expect(registry.getRegistrations()).toEqual([{ id: 'infraHosts', owner: 'infra' }]);
  });
});
