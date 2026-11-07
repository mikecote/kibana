/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerAlertZeroStepDefinitions, registerStepDefinitions } from '../step_types';
import { contribution } from './workflow_steps_contribution';

const settings = {
  serviceAccountsEnabled: true,
  managedWorkflowsReady: true,
  telemetryOptedIn: true,
};

const registerContribution = async (alertzero: Record<string, unknown> | null = settings) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      security: { authc: {}, audit: {} },
      userProfile: {},
      taskManager: { aggregate: jest.fn() },
      analytics: { reportEvent: jest.fn() },
      plugins: { security: { authz: {} } },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: alertzero ? { alertzero } : {},
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
      emitEvent: jest.fn(),
    },
  });
  await registry.isReady();
  return { registry, internalSteps };
};

/** The ids Kibana registers: what `plugin.ts` registers through the same functions. */
const registeredByKibana = (): string[] => {
  const ids: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => ids.push(definition.id),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  registerStepDefinitions({
    workflowsExtensions: registry,
    getActionsService: jest.fn(),
    getConversations: jest.fn(),
    getExecution: jest.fn(),
    getHuntServices: jest.fn(),
    isContextEngineEnabled: jest.fn(),
    getTaskManager: jest.fn(),
  });
  registerAlertZeroStepDefinitions({
    workflowsExtensions: registry,
    analytics: { reportEvent: jest.fn() },
    areServiceAccountsEnabled: () => true,
    getManagedWorkflowState: async () => undefined,
    getWorkflowsManagement: () => undefined,
    isTelemetryOptedIn: async () => true,
    logger: loggerMock.create(),
  });
  return ids;
};

/** They read the investigation conversation with Agent Builder's conversations client and executions. */
const KIBANA_ONLY_STEPS = ['hunt.packageReport', 'alertzero.investigation.summarize'];

describe('alertzero workflow-steps contribution', () => {
  it('registers every step Kibana registers, except the ones that need Agent Builder', async () => {
    const { registry, internalSteps } = await registerContribution();
    const kibana = registeredByKibana();

    expect(kibana).toHaveLength(6);
    KIBANA_ONLY_STEPS.forEach((id) => {
      expect(kibana).toContain(id);
      expect(registry.hasStepDefinition(id)).toBe(false);
    });
    const served = kibana.filter((id) => !KIBANA_ONLY_STEPS.includes(id));
    served.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + served.length);
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps } = await registerContribution(null);

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
  });

  it('declares its settings', () => {
    expect(contribution.declares?.settings).toEqual(['alertzero']);
  });
});
