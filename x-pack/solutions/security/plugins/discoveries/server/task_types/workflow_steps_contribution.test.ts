/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { runInlineGeneration } from '../workflows/generation_runner';
import { loggerMock } from '@kbn/logging-mocks';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck, WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { AD_STEP_TYPE_IDS, RunStepTypeId } from '../../common/step_types';
import { registerWorkflowSteps } from '../workflows/register_workflow_steps';
import { contribution } from './workflow_steps_contribution';
import { createWorkflowRuleDataService } from '@kbn/rule-registry-plugin/server/task_types/workflow_rule_data_services';

jest.mock('@kbn/rule-registry-plugin/server/task_types/workflow_rule_data_services', () => ({
  createWorkflowRuleDataService: jest.fn().mockResolvedValue({ initializeIndex: jest.fn() }),
}));

/** The step types Kibana registers: `plugin.ts` registers them through the same function, as loaders. */
const registeredByKibana = async (): Promise<string[]> => {
  const loaders: Array<() => Promise<{ id: string } | undefined>> = [];
  const registry = {
    registerStepDefinition: (definition: unknown) => loaders.push(definition as never),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  registerWorkflowSteps(registry, {
    runGeneration: runInlineGeneration,
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
    settings: discoveries ? { discoveries, inferenceFeatures: { features: [] } } : {},
    services: {
      stepRegistry: createServerStepRegistry(loggerMock.create()),
      registerService: jest.fn(),
      registerRunCompletion: jest.fn(),
      getService: jest.fn(),
      getExecutionEngine: jest.fn(),
      getUnsecuredActionsClient: jest.fn(),
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
  it('registers every step Kibana registers with the shared rule data service', async () => {
    jest
      .mocked(createWorkflowRuleDataService)
      .mockResolvedValue({ initializeIndex: jest.fn().mockReturnValue({}) } as never);
    const { registry, internalSteps } = await registerContribution();
    const kibana = await registeredByKibana();

    expect([...kibana].sort()).toEqual([...AD_STEP_TYPE_IDS].sort());

    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps, checks } = await registerContribution({ discoveries: null });

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(checks).toHaveLength(0);
  });

  it('declares its settings, the flag of the workflows, the per-space setting and its event log provider', () => {
    expect(contribution.declares?.settings).toEqual([
      'discoveries',
      'inferenceFeatures',
      'ruleRegistry',
      'alerting',
    ]);
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

  it('does not reject run steps that name inference features from the dispatch snapshot', async () => {
    const { checks } = await registerContribution();
    for (const featureId of ['attack_discovery', ['a', 'b']]) {
      expect(
        checks
          .map((check) =>
            check({ type: RunStepTypeId, config: { with: { feature_id: featureId } } })
          )
          .filter(Boolean)
      ).toEqual([]);
    }
  });
});
