/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import { createServerUrlService } from '@kbn/share-plugin/server';
import { InvestigationLocatorDefinition } from '../../common/locators';
import { investigationsTriggerCommonDefinitions } from '../../common/workflows/triggers';
import { NightshiftTelemetryClient } from '../telemetry';
import { registerNightshiftWorkflowSteps } from '../workflows/register_workflow_steps';
import { contribution } from './workflow_steps_contribution';

const registerContribution = async (
  nightshift: Record<string, unknown> | null = {
    workflowsManagementAvailable: true,
    decisionTreesEnabled: false,
  }
) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const internalTriggers = registry.getAllTriggerDefinitions().length;
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      analytics: { reportEvent: jest.fn() },
      savedObjects: { getScopedClient: jest.fn() },
      uiSettings: { asScopedToClient: jest.fn() },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: nightshift ? { nightshiftInvestigations: nightshift } : {},
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
  return { registry, internalSteps, internalTriggers };
};

const registeredByKibana = async (): Promise<string[]> => {
  const logger = loggerMock.create();
  const registry = createServerStepRegistry(logger);
  const analytics = { reportEvent: jest.fn() };
  registerNightshiftWorkflowSteps(registry, {
    getInference: jest.fn(),
    getSavedObjects: jest.fn(),
    getUiSettings: jest.fn(),
    getTelemetryConnectorId: jest.fn(),
    isDecisionTreesEnabled: jest.fn(),
    isCortexEnabled: jest.fn(),
    isMemoryEnabled: jest.fn(),
    logger,
    getInvestigationsClient: jest.fn(),
    getAutomationsSoClient: jest.fn(),
    getAgentBuilder: jest.fn(),
    getAgentAvailability: jest.fn(),
    getActions: jest.fn(),
    getRoutingClient: jest.fn(),
    getTriggerEmitter: jest.fn(),
    getSandboxStart: jest.fn(),
    analytics,
    telemetry: new NightshiftTelemetryClient(analytics, logger),
    investigationLocator: createServerUrlService({
      baseUrl: 'https://kibana.example.test',
      version: '9.6.0',
    }).locators.create(new InvestigationLocatorDefinition()),
  });
  await registry.isReady();
  return registry
    .getAllStepDefinitions()
    .map(({ id }) => id)
    .filter((id) => id.startsWith('nightshift.'));
};

describe('nightshift investigations workflow-steps contribution', () => {
  it('registers every Nightshift step registered by Main', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution();
    const kibana = await registeredByKibana();

    expect(kibana).toHaveLength(15);
    for (const id of kibana) expect(registry.hasStepDefinition(id)).toBe(true);
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);

    investigationsTriggerCommonDefinitions.forEach(({ id }) =>
      expect(registry.getTriggerDefinition(id)).toBeDefined()
    );
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + investigationsTriggerCommonDefinitions.length
    );
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution(null);

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(registry.getAllTriggerDefinitions()).toHaveLength(internalTriggers);
  });

  it('registers only the triggers when Kibana has no workflows management plugin, as it does', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution({
      workflowsManagementAvailable: false,
      decisionTreesEnabled: false,
    });

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + investigationsTriggerCommonDefinitions.length
    );
  });

  it('declares its settings', () => {
    expect(contribution.declares?.settings).toEqual(['nightshiftInvestigations']);
  });
});
