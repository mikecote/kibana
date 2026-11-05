/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { loggerMock } from '@kbn/logging-mocks';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck, WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import {
  AD_STEP_TYPE_IDS,
  PersistDiscoveriesStepTypeId,
  RunStepTypeId,
} from '../../common/step_types';
import { registerWorkflowSteps } from '../workflows/register_workflow_steps';
import { contribution } from './workflow_steps_contribution';

/** The step types Kibana registers: `plugin.ts` registers them through the same function, as loaders. */
const registeredByKibana = async (): Promise<string[]> => {
  const loaders: Array<() => Promise<{ id: string } | undefined>> = [];
  const registry = {
    registerStepDefinition: (definition: unknown) => loaders.push(definition as never),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  registerWorkflowSteps(registry, {
    adhocAttackDiscoveryDataClient: {} as never,
    connectorTimeout: 1,
    getEventLogIndex: async () => 'index',
    getEventLogger: async () => ({} as never),
    getStartServices: async () =>
      ({ coreStart: { featureFlags: { getBooleanValue$: () => of(true) } } } as never),
    logger: loggerMock.create(),
  });
  return (await Promise.all(loaders.map((loader) => loader()))).map((step) => step!.id);
};

const registerContribution = async ({
  discoveries = { connectorTimeout: 1000 },
}: { discoveries?: Record<string, unknown> | null } = {}) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const checks: WorkflowStepRunCheck[] = [];
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      savedObjects: { getScopedClient: jest.fn() },
      uiSettings: { asScopedToClient: jest.fn() },
      featureFlags: { getBooleanValue$: () => of(true) },
      http: { basePath: { get: () => '' } },
      security: { authc: { apiKeys: {} }, audit: {} },
      userProfile: {},
      eventLog: { getIndexPattern: () => '.kibana-event-log-*', getLogger: jest.fn() },
      analytics: { reportEvent: jest.fn() },
      plugins: { security: { authz: {} } },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: discoveries ? { discoveries } : {},
    services: {
      executionDataClients: {
        createWorkflowDataClient: jest.fn(),
        createStepDataClient: jest.fn(),
      },
      getActionsClientWithRequest: jest.fn(),
      scheduleWorkflow: jest.fn(),
      emitEvent: jest.fn(),
    },
    hasStepDefinition: (id) => registry.hasStepDefinition(id),
    registerRunCheck: (check) => checks.push(check),
  });
  await registry.isReady();
  return { registry, internalSteps, checks };
};

describe('discoveries workflow-steps contribution', () => {
  it('registers every step Kibana registers, except the one that only Kibana serves', async () => {
    const { registry, internalSteps } = await registerContribution();
    const kibana = await registeredByKibana();

    expect([...kibana].sort()).toEqual([...AD_STEP_TYPE_IDS].sort());

    const declined = [PersistDiscoveriesStepTypeId];
    declined.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(false));
    const served = kibana.filter((id) => !declined.includes(id));
    served.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + served.length);
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps, checks } = await registerContribution({ discoveries: null });

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(checks).toHaveLength(0);
  });

  it('declares its settings, the flag of the workflows, the per-space setting and its event log provider', () => {
    expect(contribution.declares?.settings).toEqual(['discoveries']);
    expect(contribution.declares?.featureFlags).toEqual({
      [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true,
    });
    expect(contribution.declares?.uiSettings?.flatMap((defaults) => Object.keys(defaults))).toEqual(
      ['securitySolution:enableAttackDiscoveryWorkflows']
    );
    expect(contribution.declares?.eventLogProviders?.map(({ provider }) => provider)).toEqual([
      'securitySolution.attackDiscovery',
    ]);
  });

  it('declines a run step that names an inference feature, which other plugins register in Kibana', async () => {
    const { checks } = await registerContribution();
    const decline = (type: string, config: Record<string, unknown>) =>
      checks.map((check) => check({ type, config })).find(Boolean);

    expect(decline(RunStepTypeId, { with: { feature_id: 'attack_discovery' } })).toMatch(
      /feature_id/
    );
    expect(decline(RunStepTypeId, { with: { feature_id: ['a', 'b'] } })).toMatch(/feature_id/);
    expect(decline(RunStepTypeId, { with: { connector_id: 'c' } })).toBeUndefined();
    expect(decline(RunStepTypeId, { with: { feature_id: [] } })).toBeUndefined();
    expect(decline('ai.prompt', { with: { feature_id: 'x' } })).toBeUndefined();
  });
});
