/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';
import { registerAlertZeroStepDefinitions, registerStepDefinitions } from '../step_types';
import { contribution } from './workflow_steps_contribution';

const settings = {
  serviceAccountsEnabled: true,
  managedWorkflowsReady: true,
  searchInferenceEndpointsAvailable: false,
  actionsServiceAvailable: true,
  huntServicesReady: true,
  fleetAgentServiceAvailable: false,
  telemetryOptedIn: true,
};

const registerContribution = async (alertzero: typeof settings | null = settings) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const checks: WorkflowStepRunCheck[] = [];
  const getService = jest.fn();
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
    registerRunCheck: (check) => checks.push(check),
    services: {
      stepRegistry: createServerStepRegistry(loggerMock.create()),
      registerService: jest.fn(),
      registerRunCompletion: jest.fn(),
      getService,
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
  return { registry, internalSteps, checks, getService };
};

/** The ids Kibana registers: what `plugin.ts` registers through the same functions. */
const registeredByKibana = (): string[] => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internal = new Set(registry.getAllStepDefinitions().map(({ id }) => id));
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
  return registry
    .getAllStepDefinitions()
    .map(({ id }) => id)
    .filter((id) => !internal.has(id));
};

describe('alertzero workflow-steps contribution', () => {
  it('registers every step Kibana registers', async () => {
    const { registry, internalSteps } = await registerContribution();
    const kibana = registeredByKibana();

    expect(kibana).toHaveLength(6);
    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps } = await registerContribution(null);

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
  });

  it('declares its settings', () => {
    expect(contribution.declares?.settings).toEqual(['alertzero']);
  });

  it.each(['alertzero.investigation.summarize', 'hunt.packageReport'])(
    'checks native Agent Builder parity before %s runs',
    async (type) => {
      const { checks, getService } = await registerContribution();
      getService.mockReturnValue(() => 'missing native tool registration');
      expect(checks[0]?.({ type: 'console', config: {} })).toBeUndefined();
      expect(getService).not.toHaveBeenCalled();
      expect(checks[0]?.({ type, config: {} })).toBe('missing native tool registration');
      expect(getService).toHaveBeenCalledWith('agentBuilder.parity');
    }
  );
});
